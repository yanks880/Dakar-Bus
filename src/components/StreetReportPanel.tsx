import { useState, type FormEvent } from 'react'
import { Info, LocateFixed, MapPin, Megaphone, Send, Trash2, TriangleAlert } from 'lucide-react'
import {
  MAX_COMMENT_LENGTH,
  MAX_PLACE_LENGTH,
  STREET_REPORT_KINDS,
  STREET_REPORT_PROVENANCE,
  STREET_REPORT_TTL_MINUTES,
  formatReportAge,
  reportKindLabel,
  type StreetReport,
  type StreetReportDraft,
  type StreetReportKind,
} from '../domain/streetReports'
import { NETWORK_SOURCES, type NetworkId } from '../domain/network'
import { isMobilityId } from '../domain/mobilityColors'
import { MobilityBadge } from './MobilityBadge'

const MIN_PLACE_LENGTH = 3

/**
 * « Direct rue » : les usagers remontent ce qu'ils voient sur la chaussée.
 *
 * Tout est local à l'appareil : le signalement n'est envoyé à aucun serveur,
 * n'est vérifié par personne et n'est jamais présenté comme une alerte
 * officielle ni comme du temps réel. Il expire de lui-même.
 */
export function StreetReportPanel({
  reports,
  now,
  location,
  onLocate,
  onSubmit,
  onRemove,
}: {
  reports: readonly StreetReport[]
  now: number
  location: { lat: number; lng: number } | null
  onLocate: () => void
  onSubmit: (draft: StreetReportDraft) => void
  onRemove: (id: string) => void
}) {
  const [kind, setKind] = useState<StreetReportKind>('CONGESTION')
  const [place, setPlace] = useState('')
  const [comment, setComment] = useState('')
  const [networkId, setNetworkId] = useState<NetworkId | null>(null)
  const [attachPosition, setAttachPosition] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const joinedPosition = attachPosition ? location : null
  const trimmedPlace = place.trim()

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (trimmedPlace.length < MIN_PLACE_LENGTH) {
      setError(`Indiquez la portion de route concernée (au moins ${MIN_PLACE_LENGTH} caractères).`)
      return
    }
    setError(null)
    onSubmit({
      kind,
      place: trimmedPlace,
      networkId,
      comment: comment.trim() || null,
      lat: joinedPosition?.lat ?? null,
      lng: joinedPosition?.lng ?? null,
    })
    setPlace('')
    setComment('')
    setNetworkId(null)
    setAttachPosition(false)
  }

  return (
    <section className="street-panel" aria-label="Direct rue">
      <div className="street-provenance">
        <Info size={16} />
        <p>{STREET_REPORT_PROVENANCE}</p>
      </div>

      <form className="street-form" onSubmit={handleSubmit}>
        <div className="street-form-heading">
          <span className="street-form-icon"><Megaphone size={16} /></span>
          <div>
            <strong>Signaler ce que vous voyez</strong>
            <small>Embouteillage, incident, travaux… sur une portion de route précise.</small>
          </div>
        </div>

        <div className="street-kind-row" role="group" aria-label="Type de situation">
          {STREET_REPORT_KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`street-kind-chip${kind === item.id ? ' selected' : ''}`}
              aria-pressed={kind === item.id}
              title={item.hint}
              onClick={() => setKind(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="street-field">
          <span>Portion de route <em>(obligatoire)</em></span>
          <input
            type="text"
            value={place}
            maxLength={MAX_PLACE_LENGTH}
            placeholder="Ex. : Patte d’Oie → Aéroport"
            onChange={(event) => setPlace(event.target.value)}
          />
        </label>

        <label className="street-field">
          <span>Réseau concerné <em>(facultatif)</em></span>
          <select
            value={networkId ?? ''}
            onChange={(event) => setNetworkId(event.target.value ? (event.target.value as NetworkId) : null)}
          >
            <option value="">Non précisé</option>
            {NETWORK_SOURCES.map((network) => (
              <option key={network.id} value={network.id}>{network.referenceData?.shortName ?? network.label}</option>
            ))}
          </select>
        </label>

        <label className="street-field">
          <span>Précision <em>(facultatif)</em></span>
          <textarea
            value={comment}
            rows={2}
            maxLength={MAX_COMMENT_LENGTH}
            placeholder="Ce que vous voyez, en une phrase."
            onChange={(event) => setComment(event.target.value)}
          />
          <small className="street-counter">{comment.length}/{MAX_COMMENT_LENGTH}</small>
        </label>

        <div className="street-position-row">
          <button
            type="button"
            className={`street-position-toggle${attachPosition ? ' is-on' : ''}`}
            aria-pressed={attachPosition}
            onClick={() => {
              if (attachPosition) {
                setAttachPosition(false)
                return
              }
              setAttachPosition(true)
              if (!location) onLocate()
            }}
          >
            <LocateFixed size={14} />
            {attachPosition ? 'Position jointe' : 'Joindre ma position'}
          </button>
          {attachPosition && location && (
            <span className="street-position-value">
              <MapPin size={13} /> {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
            </span>
          )}
          {attachPosition && !location && <span className="street-position-value">Localisation en cours…</span>}
        </div>

        {error && <p className="street-error" role="alert">{error}</p>}

        <button type="submit" className="primary-action street-submit">
          <Send size={16} />
          <span>Publier le signalement</span>
        </button>
      </form>

      <div className="street-list-heading">
        <span>SIGNALEMENTS ACTIFS SUR CET APPAREIL</span>
        <span className="source-count">{reports.length}</span>
      </div>

      {reports.length === 0 ? (
        <p className="street-empty">Aucun signalement actif. Le premier que vous publierez apparaîtra ici.</p>
      ) : (
        <ul className="street-report-list">
          {reports.map((report) => (
            <li key={report.id} className={`street-report street-report-${report.kind.toLowerCase()}`}>
              <div className="street-report-head">
                <span className="street-report-kind">{reportKindLabel(report.kind)}</span>
                <span className="street-report-age">{formatReportAge(report.createdAt, now)}</span>
                <button
                  type="button"
                  className="street-report-remove"
                  aria-label={`Retirer le signalement ${report.place}`}
                  onClick={() => onRemove(report.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <strong className="street-report-place">{report.place}</strong>
              <div className="street-report-meta">
                {isMobilityId(report.networkId) ? <MobilityBadge id={report.networkId} /> : report.networkId ? <span className="street-report-network">{report.networkId.toUpperCase()}</span> : null}
                {report.lat !== null && report.lng !== null && (
                  <span><MapPin size={12} /> {report.lat.toFixed(4)}, {report.lng.toFixed(4)}</span>
                )}
                <span className="street-report-source">non vérifié</span>
              </div>
              {report.comment && <p className="street-report-comment">{report.comment}</p>}
            </li>
          ))}
        </ul>
      )}

      <p className="street-footnote">
        <TriangleAlert size={13} />
        Visible uniquement sur cet appareil, effaçable à tout moment et automatiquement retiré après{' '}
        {STREET_REPORT_TTL_MINUTES} minutes.
      </p>
    </section>
  )
}
