export async function activate(api) {
  api.permissions.assert('storage.namespace')
  api.permissions.assert('ui.register')

  const previous = Number((await api.storage.get('activation-count')) ?? 0)
  const activationCount = Number.isFinite(previous) ? previous + 1 : 1
  await api.storage.set('activation-count', activationCount)

  await api.ui.register({
    id: 'example.basic:settings',
    type: 'settings',
    slot: 'settings.pages',
    title: 'Basic Sandbox Plugin',
    order: 100,
  })

  const root = document.getElementById('app')
  if (root) {
    const heading = document.createElement('h2')
    heading.textContent = 'Basic Sandbox Plugin'
    const copy = document.createElement('p')
    copy.textContent = `This isolated iframe has loaded ${activationCount} time(s).`
    root.replaceChildren(heading, copy)
  }

  await api.events.emit('plugin:example.basic/activated', { activationCount })

  return async () => {
    root?.replaceChildren()
  }
}

export async function showSettings() {
  return { message: 'The example settings page is mounted in plugin settings.' }
}
