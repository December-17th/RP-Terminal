import './assets/index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DebugApp } from './components/debug/DebugApp'

// The separate Debug window (WP-D1) loads the SAME renderer bundle with a `#debug` hash. Branch on it
// here so that window mounts the minimal standalone DebugApp instead of the full application shell.
const Root = window.location.hash === '#debug' ? DebugApp : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
