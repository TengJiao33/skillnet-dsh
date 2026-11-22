import { Children, Fragment, isValidElement, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'

type Choice = { value: string, label: string, group?: string, disabled: boolean }
type SelectProps = {
  value: string | number
  onValueChange: (value: string) => void
  children: ReactNode
  disabled?: boolean
  title?: string
  'aria-label': string
  compact?: boolean
  searchPlaceholder?: string
}

function textContent(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? textContent(child.props.children) : String(child)).join('')
}

function choicesFrom(children: ReactNode, group?: string): Choice[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string | number, label?: string, disabled?: boolean, children?: ReactNode }>(child)) return []
    if (child.type === Fragment) return choicesFrom(child.props.children, group)
    if (child.type === 'optgroup') return choicesFrom(child.props.children, child.props.label)
    if (child.type !== 'option') return []
    const label = textContent(child.props.children).replace(/\s+/g, ' ').trim()
    return [{ value: String(child.props.value ?? label), label, group, disabled: !!child.props.disabled }]
  })
}

function matchingChoices(choices: Choice[], query: string) {
  const text = query.trim().normalize('NFKC').toLocaleLowerCase()
  return text ? choices.filter(choice => choice.label.normalize('NFKC').toLocaleLowerCase().includes(text)) : choices
}

export function Select({ value, onValueChange, children, disabled, title, 'aria-label': label, compact, searchPlaceholder }: SelectProps) {
  const allChoices = useMemo(() => choicesFrom(children), [children])
  const selected = allChoices.find(choice => choice.value === String(value))
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const typeahead = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220, maxHeight: 320 })

  const choices = open && searchPlaceholder ? matchingChoices(allChoices, query) : allChoices
  const enabled = choices.map((choice, index) => choice.disabled ? -1 : index).filter(index => index >= 0)
  const groups = new Set(choices.map(choice => choice.group).filter(Boolean))
  const activeId = open && choices[active] ? `${id}-${active}` : undefined
  function show(index = selected && !selected.disabled ? allChoices.indexOf(selected) : enabled[0]) {
    if (trigger.current?.matches(':disabled') || !enabled.length) return
    typeahead.current = { text: '', time: 0 }
    setQuery('')
    setActive(choices[index]?.disabled ? enabled[0] : index)
    setOpen(true)
  }
  function closeAndFocusTrigger() {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  function choose(index: number) {
    const choice = choices[index]
    if (!choice || choice.disabled) return
    closeAndFocusTrigger()
    if (choice.value !== String(value)) onValueChange(choice.value)
  }
  function moveActive(direction: number) {
    const index = enabled.indexOf(active)
    if (enabled.length) setActive(enabled[Math.max(0, Math.min(enabled.length - 1, index + direction))])
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) show()
      else moveActive(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? enabled[0] : enabled.at(-1)
      if (next !== undefined) { if (!open) show(next); else setActive(next) }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) choose(active)
      else show()
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    } else if (event.key === 'Tab') {
      setOpen(false)
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now()
      const text = (now - typeahead.current.time < 700 ? typeahead.current.text : '') + event.key.toLocaleLowerCase()
      typeahead.current = { text, time: now }
      const found = choices.findIndex(choice => !choice.disabled && choice.label.toLocaleLowerCase().startsWith(text))
      if (found >= 0) {
        event.preventDefault()
        if (!open) { show(found); typeahead.current = { text, time: now } }
        else setActive(found)
      }
    }
  }

  function searchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndFocusTrigger()
    } else if (event.key === 'Tab') {
      closeAndFocusTrigger()
    }
  }

  useLayoutEffect(() => {
    if (!open) return
    if (disabled || !allChoices.length) { setOpen(false); return }
    function place() {
      if (!trigger.current || !menu.current) return
      const rect = trigger.current.getBoundingClientRect()
      const edge = 12, gap = 6
      const below = window.innerHeight - rect.bottom - gap - edge
      const above = rect.top - gap - edge
      const aboveTrigger = below < Math.min(menu.current.scrollHeight, 240) && above > below
      const maxHeight = Math.max(searchPlaceholder ? 96 : 44, Math.min(320, aboveTrigger ? above : below))
      const width = Math.min(Math.max(rect.width, searchPlaceholder ? 260 : 220), window.innerWidth - edge * 2)
      const height = Math.min(menu.current.scrollHeight, maxHeight)
      setPosition({ width, maxHeight, left: Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge)), top: aboveTrigger ? Math.max(edge, rect.top - gap - height) : rect.bottom + gap })
    }
    function outside(event: Event) {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    function scroll(event: Event) {
      const target = event.target as Node
      if (menu.current?.contains(target)) return
      if (event.target === document || event.target === window || target instanceof Element && target.contains(trigger.current)) setOpen(false)
    }
    place()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open, disabled, allChoices.length, choices.length, searchPlaceholder])

  useLayoutEffect(() => {
    if (open) search.current?.focus({ preventScroll: true })
  }, [open, searchPlaceholder])

  useLayoutEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId, query])

  return <>
    <button ref={trigger} type="button" className={`sn-select${compact ? ' sn-select-compact' : ''}`} role="combobox"
      aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={searchPlaceholder ? undefined : activeId}
      disabled={disabled || !allChoices.length} title={title || selected?.label}
      onClick={() => open ? setOpen(false) : show()} onKeyDown={keyDown}>
      <span className="sn-select-value">{selected?.label || '请选择'}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && createPortal(<div className="skillnet-shell sn-select-portal">
      <div ref={menu} className={`sn-select-menu${searchPlaceholder ? ' sn-select-searchable' : ''}`} style={position}>
        {searchPlaceholder && <div className="sn-select-search">
          <Search size={15} aria-hidden="true" />
          <input ref={search} type="text" role="combobox" aria-label={searchPlaceholder} placeholder={searchPlaceholder}
            aria-expanded="true" aria-autocomplete="list" aria-controls={id} aria-activedescendant={activeId}
            value={query} onKeyDown={searchKeyDown} onChange={event => {
              const next = event.target.value
              setQuery(next)
              setActive(matchingChoices(allChoices, next).findIndex(choice => !choice.disabled))
            }} />
        </div>}
        <div id={id} className="sn-select-options" role="listbox" aria-label={label}>
          {choices.map((choice, index) => {
            const current = choice.value === String(value)
            return <Fragment key={choice.value}>
              {groups.size > 1 && choice.group && choice.group !== choices[index - 1]?.group && <div className="sn-select-group">{choice.group}</div>}
              <div id={`${id}-${index}`} role="option" aria-selected={current} aria-disabled={choice.disabled || undefined}
                className={`sn-select-option${index === active ? ' is-active' : ''}`}
                onPointerMove={() => { if (!choice.disabled) setActive(index) }}
                onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
                <span>{choice.label}</span>{current && <Check size={16} aria-hidden="true" />}
              </div>
            </Fragment>
          })}
        </div>
        {searchPlaceholder && !choices.length && <div className="sn-select-empty" role="status">没有匹配的选项</div>}
      </div>
    </div>, trigger.current?.closest('dialog') || document.body)}
  </>
}
