import React from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export function DialogHeader({ id, title, subtitle, onClose, closeLabel = '关闭', disabled = false }: {
  id: string, title: string, subtitle?: ReactNode, onClose: () => void, closeLabel?: string, disabled?: boolean,
}) {
  return <header className="dsh-dialog-header dsh-package-dialog-header">
    <div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
    <button type="button" className="dsh-dialog-close" aria-label={closeLabel} disabled={disabled} onClick={onClose}>
      <X size={16} strokeWidth={1.8} aria-hidden="true" />
    </button>
  </header>
}
