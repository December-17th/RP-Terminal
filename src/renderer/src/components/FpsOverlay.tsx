import React, { useEffect, useState } from 'react'

/**
 * Small bottom-right FPS counter driven by requestAnimationFrame frame timing.
 * Updates once per second; the rAF loop is torn down when unmounted (so it costs
 * nothing when the overlay is toggled off).
 */
export const FpsOverlay: React.FC = () => {
  const [fps, setFps] = useState(0)

  useEffect(() => {
    let raf = 0
    let frames = 0
    let last = performance.now()
    const tick = (now: number): void => {
      frames++
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const color = fps >= 50 ? '#4caf72' : fps >= 30 ? '#e6b800' : '#e74c3c'
  return (
    <div className="fps-overlay" style={{ color }}>
      {fps} FPS
    </div>
  )
}
