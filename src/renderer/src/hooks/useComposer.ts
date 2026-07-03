import { useEffect, useRef, useState } from 'react'
import { useToastStore } from '../stores/toastStore'
import { useComposerStore } from '../stores/composerStore'
import { isSlashLine, runSlash, listCommands, SlashCommand } from '../plugin/slash'

export interface ComposerApi {
  actionInput: string
  onChange: (value: string) => void
  setSlashIndex: React.Dispatch<React.SetStateAction<number>>
  setSlashDismissed: React.Dispatch<React.SetStateAction<boolean>>
  slashItems: SlashCommand[]
  slashOpen: boolean
  slashActive: number
  completeCommand: (cmd: SlashCommand) => void
  submit: () => void
  actionRef: React.RefObject<HTMLTextAreaElement | null>
}

/**
 * The action-box state machine: free text + slash-command autocomplete. A leading "/"
 * with no space yet shows a menu of matching commands; submitting a slash line runs the
 * command (output toasted) instead of generating; otherwise `onSendMessage` starts a turn.
 */
export function useComposer({
  onSendMessage
}: {
  onSendMessage: (text: string) => void
}): ComposerApi {
  // The box text is STORE-owned (composerStore.text) so scripts can inject (`/setinput`, `/send`)
  // and submit (`/trigger` → requestSubmit) it synchronously; this hook subscribes + edits it.
  const actionInput = useComposerStore((s) => s.text)
  const setActionInput = (value: string): void => useComposerStore.getState().setText(value)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const actionRef = useRef<HTMLTextAreaElement>(null)

  // An injection (card onboarding / /setinput / /send) focuses the box for the player.
  const focusTick = useComposerStore((s) => s.focusTick)
  useEffect(() => {
    if (focusTick > 0) requestAnimationFrame(() => actionRef.current?.focus())
  }, [focusTick])

  // While the box holds just "/" + a partial command name (no space yet), show a menu
  // of matching commands above the input.
  const slashQueryMatch = actionInput.match(/^\/(\S*)$/)
  const slashQuery = slashQueryMatch ? slashQueryMatch[1].toLowerCase() : null
  const slashItems =
    slashQuery === null ? [] : listCommands().filter((c) => c.name.startsWith(slashQuery))
  const slashOpen = slashQuery !== null && !slashDismissed && slashItems.length > 0
  const slashActive = Math.min(slashIndex, slashItems.length - 1)

  // Accept a command from the menu: fill the box with "/name " ready for args.
  const completeCommand = (cmd: SlashCommand): void => {
    setActionInput('/' + cmd.name + ' ')
    setSlashDismissed(false)
    setSlashIndex(0)
    requestAnimationFrame(() => actionRef.current?.focus())
  }

  // Submit the action box: a leading "/" runs a slash command (output toasted)
  // instead of starting a generation.
  const submit = (): void => {
    const text = actionInput.trim()
    if (!text) return
    if (isSlashLine(text)) {
      runSlash(text).then((out) => {
        if (out) useToastStore.getState().push(out)
      })
      setActionInput('')
      return
    }
    onSendMessage(text)
    setActionInput('')
  }

  // A script asked to "press the send button" (`/trigger` → composerStore.requestSubmit): run the
  // SAME submit as the button/Enter over the current box content. `submitRef` keeps the freshest
  // closure; store writes are synchronous, so a `/setinput x | /trigger` combo re-rendered this
  // hook with the injected text BEFORE this effect fires.
  const submitRef = useRef(submit)
  submitRef.current = submit
  const submitTick = useComposerStore((s) => s.submitTick)
  useEffect(() => {
    if (submitTick > 0) submitRef.current()
  }, [submitTick])

  // Edit the text + reset the slash menu's transient nav state.
  const onChange = (value: string): void => {
    setActionInput(value)
    setSlashDismissed(false)
    setSlashIndex(0)
  }

  return {
    actionInput,
    onChange,
    setSlashIndex,
    setSlashDismissed,
    slashItems,
    slashOpen,
    slashActive,
    completeCommand,
    submit,
    actionRef
  }
}
