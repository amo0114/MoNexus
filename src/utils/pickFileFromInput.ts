export function pickFileFromInput(input: HTMLInputElement | null): Promise<File | null> {
  if (!input) return Promise.resolve(null)
  return new Promise((resolve) => {
    const done = (file: File | null) => {
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', onCancel)
      input.value = ''
      resolve(file)
    }
    const onChange = () => done(input.files?.[0] ?? null)
    const onCancel = () => done(null)
    input.addEventListener('change', onChange, { once: true })
    input.addEventListener('cancel', onCancel, { once: true })
    input.click()
  })
}
