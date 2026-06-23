import React from 'react'

/** Pure: build an SVG path ("M..L..") mapping values across width, inverted to height,
 * scaled between min..max. Empty for <2 points. Exported for unit testing. */
export const linePath = (
  values: number[],
  width: number,
  height: number,
  min: number,
  max: number
): string => {
  if (values.length < 2) return ''
  const span = max - min || 1
  const step = width / (values.length - 1)
  return values
    .map((v, i) => {
      const x = Math.round(i * step)
      const y = Math.round(height - ((v - min) / span) * height)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    })
    .join(' ')
}

export interface Series {
  label: string
  color: string
  values: number[]
}

/** A small multi-series line chart (hand-rolled SVG, no chart dep). */
export const TurnChart: React.FC<{ series: Series[]; min: number; max: number; height?: number }> = ({
  series,
  min,
  max,
  height = 80
}) => {
  const width = 280
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {series.map((s) => (
        <path key={s.label} d={linePath(s.values, width, height, min, max)} fill="none" stroke={s.color} strokeWidth={1.5} />
      ))}
    </svg>
  )
}
