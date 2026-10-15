import { useEffect, useState } from 'react'
/** Text-area presentation with optional idle placeholder rotation. */
import type { CSSProperties, KeyboardEventHandler, ReactNode, RefObject } from 'react'
import type { LexicalEditor } from 'lexical'
import clsx from 'clsx'
import type { InputState } from '../../contract/input.ts'
import { ComposerContentEditable } from './ComposerContentEditable.tsx'
import { DecoratorPortals } from './DecoratorPortals.tsx'

/** Text-area values and the scrollport reference retained by InputBar. */
export interface DraftEditorProps {
  readonly classNames: Readonly<Record<string, string>>
  readonly editor: LexicalEditor | null
  readonly scrollRef: RefObject<HTMLDivElement>
  readonly editable: boolean
  readonly editorDisabled: boolean
  readonly phase: InputState['phase'] | 'inert'
  readonly placeholderExamples?: readonly string[]
  readonly placeholderText: string
  readonly ariaLabel: string
  readonly workspaceTrigger: boolean
  readonly workspacePickerOpen: boolean
  readonly onWorkspaceKeyDown: KeyboardEventHandler<HTMLDivElement>
  readonly hint: string | null
  readonly showPlaceholder: boolean
}

/**
 * Render the existing scrollport, editable surface, placeholder, and chip portals.
 * @param props - borrowed editor and presentation values; local state only controls idle examples.
 * @returns the existing text-area DOM without an additional wrapper.
 */
export function DraftEditor({
  classNames: css, editor, scrollRef, editable, editorDisabled, phase, placeholderText, ariaLabel,
  workspaceTrigger, workspacePickerOpen, onWorkspaceKeyDown, hint, showPlaceholder, placeholderExamples,
}: DraftEditorProps): ReactNode {
  const [focused, setFocused] = useState(false)
  const [example, setExample] = useState(0)
  const count = placeholderExamples?.length ?? 0
  useEffect(() => {
    if (focused || !showPlaceholder || count < 2) return
    const timer = window.setInterval(() =>{  setExample(value => (value + 1) % count) }, 5000)
    return () =>{  window.clearInterval(timer) }
  }, [focused, showPlaceholder, count])
  const visiblePlaceholder = count > 0 ? placeholderExamples?.[example % count] : placeholderText
  return (
    <div ref={scrollRef} className={css.scroll} data-input-scroll
      onFocusCapture={() =>{  setFocused(true) }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
      <div className={css.grow}>
        <ComposerContentEditable
          editor={workspaceTrigger ? null : editor}
          editable={editable}
          className={clsx(css.input, editorDisabled && css.inputDisabled)}
          data-phase={phase}
          aria-disabled={editorDisabled || undefined}
          data-placeholder={placeholderText}
          // The placeholder was the textarea's accessible name; a div's
          // data attribute is not, so the label restores it.
          aria-label={ariaLabel}
          aria-haspopup={workspaceTrigger ? 'menu' : undefined}
          aria-expanded={workspaceTrigger ? workspacePickerOpen : undefined}
          tabIndex={workspaceTrigger ? 0 : undefined}
          onKeyDown={workspaceTrigger ? onWorkspaceKeyDown : undefined}
          style={hint === null ? undefined : { '--dsh-composer-hint': JSON.stringify(hint) } as CSSProperties}
        />
        {showPlaceholder && (
          <div aria-hidden className={css.placeholder} data-composer-placeholder>
            {count > 0
              ? <span key={example} className={focused ? undefined : css.rotatingPlaceholder}>{visiblePlaceholder}</span>
              : placeholderText}
          </div>
        )}
        <DecoratorPortals editor={workspaceTrigger ? null : editor} />
      </div>
    </div>
  )
}
