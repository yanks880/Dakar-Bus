import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Info, MapPin, Search, X } from 'lucide-react'
import { searchStopIndex, type StopOption } from '../domain/stops'

/**
 * Champ de recherche d'un point de trajet.
 *
 * L'index couvre toutes les mobilités suivies et tous les arrêts réellement
 * déclarés (gares TER, stations BRT, arrêts du snapshot publié). Une mobilité
 * dont les arrêts ne sont pas publiés (AFTU, DDD, TATA) reste cherchable pour
 * être trouvée, mais elle ne crée pas de point : elle explique pourquoi.
 */
export function StopCombobox({
  title,
  point,
  options,
  isPicking,
  onPick,
  onClear,
  onPickOnMap,
}: {
  title: string
  point: { label: string; detail?: string | null } | null
  options: readonly StopOption[]
  isPicking: boolean
  onPick: (option: StopOption) => void
  onClear: () => void
  onPickOnMap: () => void
}) {
  const listId = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Sans saisie, la liste propose les premières entrées de l’index : l’usager
  // voit ce qui est cherchable avant même de taper.
  const matches = useMemo(
    () => (query.trim() ? searchStopIndex(options, query, 14) : options.slice(0, 16)),
    [options, query],
  )

  useEffect(() => setActiveIndex(0), [query])

  // Une fermeture au clic extérieur : la liste ne reste jamais ouverte au-dessus
  // d'un autre champ.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  function choose(option: StopOption) {
    onPick(option)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (matches.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => (current + delta + matches.length) % matches.length)
      return
    }
    if (event.key === 'Enter') {
      if (open && matches[activeIndex]) {
        event.preventDefault()
        choose(matches[activeIndex])
      }
      return
    }
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        setOpen(false)
      }
    }
  }

  return (
    <div className={`point-field${isPicking ? ' picking' : ''}`} ref={wrapRef}>
      <span className={`point-symbol ${title === 'Départ' ? 'origin-symbol' : 'destination-symbol'}`} aria-hidden="true"><i /></span>

      <div className="point-field-content">
        <span className="point-title">{title}</span>
        {point ? (
          <div className="combobox-picked">
            <span className="combobox-picked-label" title={point.label}>{point.label}</span>
            {point.detail && <small>{point.detail}</small>}
          </div>
        ) : (
          <input
            ref={inputRef}
            className="point-search-input"
            type="text"
            role="combobox"
            aria-label={`${title} du trajet`}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="Arrêt, station ou mobilité…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
          />
        )}
      </div>

      {point ? (
        <button type="button" className="point-icon-button" aria-label={`Retirer le ${title.toLowerCase()}`} onClick={onClear}>
          <X size={15} />
        </button>
      ) : (
        <span className="point-field-search-icon" aria-hidden="true"><Search size={15} /></span>
      )}

      <button
        type="button"
        className={`point-icon-button point-map-button${isPicking ? ' is-picking' : ''}`}
        aria-label="Choisir un point sur la carte"
        title="Choisir un point sur la carte"
        onClick={onPickOnMap}
      >
        <MapPin size={16} />
      </button>

      {open && (
        <div className="point-options">
          {matches.length > 0 ? (
            <ul className="point-option-list" id={listId} role="listbox" aria-label={`${title} : arrêts et mobilités`}>
              {matches.map((option, index) => (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className={`point-option${index === activeIndex ? ' is-active' : ''}${option.selectable ? '' : ' is-informative'}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                  >
                    <span className="point-option-main">
                      <strong>{option.label}</strong>
                      <small>{option.hint}</small>
                    </span>
                    {option.selectable ? (
                      <span className="point-option-group">{option.group}</span>
                    ) : (
                      <span className="point-option-group point-option-group-info"><Info size={12} /> non utilisable</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="point-options-empty">
              Aucun arrêt ni mobilité ne correspond à « {query.trim()} ». Aucun lieu n’est deviné.
            </p>
          )}
          <p className="point-options-note">
            Arrêts disponibles : TER (13 gares SETER), BRT (23 stations SunuBRT) et arrêts du snapshot publié.
            AFTU, DDD et TATA sont référencés mais leurs arrêts ne sont pas publiés.
          </p>
        </div>
      )}
    </div>
  )
}
