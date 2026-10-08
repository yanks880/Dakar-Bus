import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  KeyRound,
  Lock as LockIcon,
  LogOut,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react'

import { REQUIRED_ATTESTATIONS, formatTimestamp, type CatalogDataset } from './domain/review'
import {
  ACTOR_ID_PATTERN,
  ROLE_LABELS,
  approveVersion,
  canPublish,
  canReview,
  emptyAttestations,
  login,
  logout,
  publishVersion,
  readSession,
  rejectVersion,
  revertPublication,
  revertVersionDecision,
  type AttestationInput,
  type SessionState,
} from './domain/session'

type FormKind = 'approve' | 'reject' | 'revert' | 'publish' | 'revert-publication'

interface OpenForm {
  datasetId: string
  kind: FormKind
}

interface Notice {
  tone: 'ok' | 'error'
  title: string
  lines: string[]
}

const EMPTY_SESSION: SessionState = { authenticated: false, actor: null, csrfToken: null, expiresAt: null }

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : 'empreinte non transmise'
}

/** The console decides nothing by itself: every button is a write on the local API. */
export function ConsolePanel({ datasets, onChanged }: { datasets: readonly CatalogDataset[]; onChanged: () => void }) {
  const [session, setSession] = useState<SessionState | null>(null)
  const [actorId, setActorId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [open, setOpen] = useState<OpenForm | null>(null)
  const [attestations, setAttestations] = useState<Record<string, AttestationInput>>(emptyAttestations)
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [entryId, setEntryId] = useState('')

  const refreshSession = useCallback(async () => {
    const outcome = await readSession()
    setSession(outcome.ok ? outcome.value : { ...EMPTY_SESSION })
    if (!outcome.ok) {
      setNotice({
        tone: 'error',
        title: outcome.status === 0 ? 'API locale injoignable' : `Session indisponible (HTTP ${outcome.status})`,
        lines: [outcome.message, ...outcome.blockers],
      })
    }
  }, [])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  const openForm = (dataset: CatalogDataset, kind: FormKind) => {
    setOpen({ datasetId: dataset.datasetId, kind })
    setAttestations(emptyAttestations())
    setNote('')
    setReason('')
    setEntryId(dataset.reviewEntryId ?? '')
    setNotice(null)
  }

  const closeForm = () => setOpen(null)

  const reportRefusal = (message: string, blockers: string[]) => {
    setNotice({ tone: 'error', title: 'Le serveur a refusé l’écriture', lines: [message, ...blockers] })
  }

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!ACTOR_ID_PATTERN.test(actorId.trim().toLowerCase())) {
      setNotice({
        tone: 'error',
        title: 'Identifiant invalide',
        lines: ['Un identifiant d’acteur est en minuscules (lettres, chiffres, « . », « _ », « - »), 3 à 40 caractères.'],
      })
      return
    }
    setBusy(true)
    const outcome = await login(actorId.trim().toLowerCase(), secret)
    setBusy(false)
    if (!outcome.ok) {
      reportRefusal(outcome.message, outcome.blockers)
      return
    }
    setSession(outcome.value)
    setSecret('')
    setNotice({
      tone: 'ok',
      title: `Session ouverte : ${outcome.value.actor?.displayName ?? outcome.value.actor?.actorId}`,
      lines: [
        `Rôle « ${ROLE_LABELS[outcome.value.actor?.role ?? 'reviewer']} » ; le secret n’a pas été conservé par le navigateur.`,
        'Le cookie de session est HttpOnly et SameSite=Strict ; le jeton CSRF accompagne chaque écriture.',
      ],
    })
  }

  const submitLogout = async () => {
    if (!session) return
    setBusy(true)
    const outcome = await logout(session)
    setBusy(false)
    setSession({ ...EMPTY_SESSION })
    setOpen(null)
    setNotice(
      outcome.ok
        ? { tone: 'ok', title: 'Session fermée', lines: ['Le cookie a été effacé côté serveur et côté navigateur.'] }
        : { tone: 'error', title: 'Fermeture refusée', lines: [outcome.message, ...outcome.blockers] },
    )
  }

  const run = async (dataset: CatalogDataset, label: string) => {
    if (!session || !open) return
    setBusy(true)
    const request = { datasetId: dataset.datasetId, state: session, note: note || null, reason: reason || null }
    const outcome =
      open.kind === 'approve'
        ? await approveVersion({ ...request, attestations })
        : open.kind === 'reject'
          ? await rejectVersion(request)
          : open.kind === 'revert'
            ? await revertVersionDecision({ ...request, entryId })
            : open.kind === 'publish'
              ? await publishVersion(request)
              : await revertPublication({ state: session, reason, snapshotId: dataset.publicationSnapshotId })
    setBusy(false)

    if (!outcome.ok) {
      reportRefusal(outcome.message, outcome.blockers)
      return
    }
    const result = outcome.value
    setNotice({
      tone: 'ok',
      title: `${label} enregistré par le serveur`,
      lines: [
        `Acteur : ${result.actorId ?? 'non transmis'} · méthode : ${result.method ?? 'non transmise'}.`,
        `Entrée de journal : ${result.entryId ?? 'non transmise'} (empreinte ${shortHash(result.entryHash)}) · horodatée ${formatTimestamp(result.recordedAt)}.`,
        result.reviewStatus ? `État de revue : ${result.reviewStatus} · publication : ${result.publicationStatus ?? 'inconnue'}.` : '',
      ].filter((line) => line.length > 0),
    })
    setOpen(null)
    onChanged()
  }

  const actor = session?.actor ?? null
  const roleLabel = actor ? ROLE_LABELS[actor.role] : null
  const actionable = useMemo(
    () => datasets.filter((dataset) => dataset.integrity !== 'INVALID'),
    [datasets],
  )

  return (
    <section className="console-panel" aria-label="Décisions authentifiées">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">DÉCISIONS AUTHENTIFIÉES</span>
          <h3>Console connectée.</h3>
          <p>Approuver, refuser, publier ou annuler exige un compte local : aucune décision anonyme n’est enregistrée.</p>
        </div>
        <span className="governance-heading-icon"><KeyRound size={19} /></span>
      </div>

      {session === null && (
        <div className="console-state" role="status">
          <span className="governance-status-icon is-loading"><RefreshCw size={15} className="is-spinning" /></span>
          <div><strong>Lecture de la session…</strong><span>Interrogation de <code>/api/session</code> sur l’API locale.</span></div>
        </div>
      )}

      {session !== null && !session.authenticated && (
        <form className="console-login" onSubmit={submitLogin}>
          <div className="console-state">
            <span className="governance-status-icon is-offline"><ShieldCheck size={15} /></span>
            <div>
              <strong>Aucune session ouverte</strong>
              <span>
                Les écritures sont refusées sans compte. Créez-en un :{' '}
                <code>npm run actors -- create &lt;identifiant&gt; --name "&lt;nom&gt;" --role reviewer --created-by &lt;autre.acteur&gt;</code>
              </span>
            </div>
          </div>
          <label htmlFor="console-actor">Identifiant d’acteur</label>
          <input
            id="console-actor"
            name="actor_id"
            type="text"
            autoComplete="username"
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
            placeholder="prenom.nom"
            required
          />
          <label htmlFor="console-secret">Secret du compte</label>
          <input
            id="console-secret"
            name="secret"
            type="password"
            autoComplete="current-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
          />
          <button type="submit" className="console-action console-action-primary" disabled={busy}>
            <KeyRound size={14} /> {busy ? 'Ouverture…' : 'Ouvrir une session'}
          </button>
          <p className="console-hint">
            Le secret est vérifié contre son empreinte scrypt et n’est jamais écrit ni conservé par le navigateur.
          </p>
        </form>
      )}

      {session?.authenticated && actor && (
        <>
          <div className="console-state console-state-connected" role="status">
            <span className="governance-status-icon is-online"><LockIcon size={15} /></span>
            <div>
              <strong>{actor.displayName ?? actor.actorId}</strong>
              <span>
                {actor.actorId} · rôle « {roleLabel} » · session jusqu’à {formatTimestamp(session.expiresAt)}
              </span>
            </div>
            <button type="button" className="governance-refresh" onClick={() => void submitLogout()} aria-label="Fermer la session">
              <LogOut size={14} />
            </button>
          </div>

          {actionable.length === 0 && (
            <div className="governance-empty">
              <span className="governance-empty-icon"><AlertTriangle size={18} /></span>
              <div>
                <strong>Aucune version décidable</strong>
                <span>Le catalogue ne contient aucune version intacte : rien n’est proposé à la décision.</span>
              </div>
            </div>
          )}

          <ul className="console-dataset-list">
            {actionable.map((dataset) => {
              const canApprove = canReview(actor) && dataset.reviewStatus !== 'APPROVED'
              const canReject = canReview(actor) && dataset.reviewStatus !== 'REJECTED'
              const canRevert = canReview(actor) && (dataset.reviewStatus === 'APPROVED' || dataset.reviewStatus === 'REJECTED')
              const canPublishNow = canPublish(actor) && dataset.reviewStatus === 'APPROVED' && dataset.publicationStatus !== 'PUBLISHED'
              const canRevertPublication = canPublish(actor) && dataset.publicationStatus === 'PUBLISHED'
              const form = open?.datasetId === dataset.datasetId ? open.kind : null

              return (
                <li className="console-dataset" key={dataset.datasetId}>
                  <div className="governance-dataset-head">
                    <strong>{dataset.operator ?? 'Opérateur non déclaré'}</strong>
                    <span className={`governance-badge governance-badge-${dataset.reviewStatus.toLowerCase()}`}>
                      {dataset.reviewStatus === 'APPROVED' ? 'Approuvé' : dataset.reviewStatus === 'REJECTED' ? 'Refusé' : dataset.reviewStatus === 'PENDING_REVIEW' ? 'En revue' : 'État inconnu'}
                    </span>
                  </div>
                  <span className="governance-dataset-id">{dataset.datasetId}</span>
                  <dl className="governance-dataset-meta">
                    <div><dt>Version</dt><dd>{dataset.datasetVersion ?? 'inconnue'}</dd></div>
                    <div><dt>Décision active</dt><dd>{dataset.reviewEntryId ?? 'aucune'}</dd></div>
                    <div><dt>Rélecteur</dt><dd>{dataset.reviewerId ?? 'aucun'}</dd></div>
                    <div><dt>Publication</dt><dd>{dataset.publicationStatus}{dataset.publicationSnapshotId ? ` · ${dataset.publicationSnapshotId}` : ''}</dd></div>
                  </dl>

                  {!canApprove && !canReject && !canRevert && !canPublishNow && !canRevertPublication && (
                    <p className="console-hint">
                      Votre rôle ne permet aucune action sur cette version ; la séparation des devoirs est appliquée par le serveur, pas par cette page.
                    </p>
                  )}

                  <div className="console-actions">
                    {canApprove && (
                      <button type="button" className="console-action" onClick={() => openForm(dataset, 'approve')}>
                        <CheckCircle2 size={14} /> Approuver
                      </button>
                    )}
                    {canReject && (
                      <button type="button" className="console-action" onClick={() => openForm(dataset, 'reject')}>
                        <Ban size={14} /> Refuser
                      </button>
                    )}
                    {canRevert && (
                      <button type="button" className="console-action" onClick={() => openForm(dataset, 'revert')}>
                        <RotateCcw size={14} /> Annuler la décision
                      </button>
                    )}
                    {canPublishNow && (
                      <button type="button" className="console-action" onClick={() => openForm(dataset, 'publish')}>
                        <UploadCloud size={14} /> Publier
                      </button>
                    )}
                    {canRevertPublication && (
                      <button type="button" className="console-action" onClick={() => openForm(dataset, 'revert-publication')}>
                        <RotateCcw size={14} /> Annuler la publication
                      </button>
                    )}
                  </div>

                  {form === 'approve' && (
                    <div className="console-form">
                      <strong>Approbation nominative</strong>
                      <p className="console-hint">Les cinq attestations sont obligatoires ; une preuve URL est exigée pour l’identité de la source.</p>
                      {REQUIRED_ATTESTATIONS.map((item) => (
                        <fieldset key={item.id}>
                          <legend>{item.label}</legend>
                          <label htmlFor={`evidence-${dataset.datasetId}-${item.id}`}>Preuve constatée</label>
                          <textarea
                            id={`evidence-${dataset.datasetId}-${item.id}`}
                            rows={2}
                            value={attestations[item.id]?.evidence ?? ''}
                            onChange={(event) =>
                              setAttestations((current) => ({
                                ...current,
                                [item.id]: { evidence: event.target.value, reference: current[item.id]?.reference ?? null },
                              }))
                            }
                          />
                          <label htmlFor={`reference-${dataset.datasetId}-${item.id}`}>URL de preuve (facultative hors source_identity)</label>
                          <input
                            id={`reference-${dataset.datasetId}-${item.id}`}
                            type="url"
                            value={attestations[item.id]?.reference ?? ''}
                            onChange={(event) =>
                              setAttestations((current) => ({
                                ...current,
                                [item.id]: { evidence: current[item.id]?.evidence ?? '', reference: event.target.value || null },
                              }))
                            }
                          />
                        </fieldset>
                      ))}
                      <label htmlFor={`note-${dataset.datasetId}`}>Note de revue (facultative)</label>
                      <input id={`note-${dataset.datasetId}`} type="text" value={note} onChange={(event) => setNote(event.target.value)} />
                      <div className="console-actions">
                        <button type="button" className="console-action console-action-primary" disabled={busy} onClick={() => void run(dataset, 'Approbation')}>
                          <Send size={14} /> {busy ? 'Enregistrement…' : 'Approuver cette version'}
                        </button>
                        <button type="button" className="console-action" onClick={closeForm}>Annuler</button>
                      </div>
                    </div>
                  )}

                  {form === 'reject' && (
                    <div className="console-form">
                      <strong>Refus motivé</strong>
                      <label htmlFor={`reason-${dataset.datasetId}`}>Motif du refus (au moins 12 caractères)</label>
                      <textarea id={`reason-${dataset.datasetId}`} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
                      <div className="console-actions">
                        <button type="button" className="console-action console-action-primary" disabled={busy} onClick={() => void run(dataset, 'Refus')}>
                          <Send size={14} /> {busy ? 'Enregistrement…' : 'Enregistrer le refus'}
                        </button>
                        <button type="button" className="console-action" onClick={closeForm}>Annuler</button>
                      </div>
                    </div>
                  )}

                  {form === 'revert' && (
                    <div className="console-form">
                      <strong>Annulation de la décision active</strong>
                      <p className="console-hint">L’annulation ajoute une entrée : la décision annulée reste lisible dans le journal.</p>
                      <label htmlFor={`entry-${dataset.datasetId}`}>Identifiant de la décision</label>
                      <input id={`entry-${dataset.datasetId}`} type="text" value={entryId} onChange={(event) => setEntryId(event.target.value)} />
                      <label htmlFor={`revert-reason-${dataset.datasetId}`}>Motif de l’annulation (au moins 12 caractères)</label>
                      <textarea id={`revert-reason-${dataset.datasetId}`} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
                      <div className="console-actions">
                        <button type="button" className="console-action console-action-primary" disabled={busy} onClick={() => void run(dataset, 'Annulation de la décision')}>
                          <Send size={14} /> {busy ? 'Enregistrement…' : 'Annuler la décision'}
                        </button>
                        <button type="button" className="console-action" onClick={closeForm}>Annuler</button>
                      </div>
                    </div>
                  )}

                  {form === 'publish' && (
                    <div className="console-form">
                      <strong>Publication d’un snapshot daté</strong>
                      <p className="console-hint">La publication gèle la version approuvée ; elle ne peut pas être faite par la personne qui l’a approuvée.</p>
                      <label htmlFor={`publish-note-${dataset.datasetId}`}>Note de publication (au moins 12 caractères)</label>
                      <textarea id={`publish-note-${dataset.datasetId}`} rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
                      <div className="console-actions">
                        <button type="button" className="console-action console-action-primary" disabled={busy} onClick={() => void run(dataset, 'Publication')}>
                          <Send size={14} /> {busy ? 'Publication…' : 'Publier cette version'}
                        </button>
                        <button type="button" className="console-action" onClick={closeForm}>Annuler</button>
                      </div>
                    </div>
                  )}

                  {form === 'revert-publication' && (
                    <div className="console-form">
                      <strong>Annulation de la publication</strong>
                      <p className="console-hint">
                        L’API cesse de servir le snapshot {dataset.publicationSnapshotId ?? 'actif'} ; le fichier publié reste sur disque et l’entrée reste lisible.
                      </p>
                      <label htmlFor={`revert-publication-reason-${dataset.datasetId}`}>Motif de l’annulation (au moins 12 caractères)</label>
                      <textarea id={`revert-publication-reason-${dataset.datasetId}`} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
                      <div className="console-actions">
                        <button type="button" className="console-action console-action-primary" disabled={busy} onClick={() => void run(dataset, 'Annulation de la publication')}>
                          <Send size={14} /> {busy ? 'Annulation…' : 'Annuler la publication'}
                        </button>
                        <button type="button" className="console-action" onClick={closeForm}>Annuler</button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      {notice && (
        <div className={`console-notice console-notice-${notice.tone}`} role="status" aria-live="polite">
          <strong>{notice.title}</strong>
          <ul>
            {notice.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export default ConsolePanel
