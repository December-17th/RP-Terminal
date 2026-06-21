import { useRef, useState } from 'react'
import { useToastStore } from '../stores/toastStore'
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
  const [actionInput, setActionInput] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const actionRef = useRef<HTMLTextAreaElement>(null)

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
