import appIconUrl from '../../app-icon.svg'

export function AppIcon() {
  return (
    <img
      src={appIconUrl}
      alt=""
      className="app-icon"
      draggable={false}
    />
  )
}
