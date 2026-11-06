/** Convierte las muestras de una sesión a TCX, el formato que aceptan Strava y Garmin Connect. */
const round1 = (x) => Math.round(x * 10) / 10

export function sessionToTcx(records) {
  const first = records[0]
  const last = records[records.length - 1]
  const startKm = first.distanciaKm ?? 0
  const seconds = Math.max(1, Math.round((Date.parse(last.timestamp) - Date.parse(first.timestamp)) / 1000))
  const meters = last.distanciaKm === undefined ? 0 : round1((last.distanciaKm - startKm) * 1000)
  const calories = last.calorias === undefined ? 0 : Math.max(0, last.calorias - (first.calorias ?? 0))
  const pulses = records.filter((r) => r.pulso !== undefined).map((r) => r.pulso)
  const start = new Date(first.timestamp).toISOString()

  const points = records
    .map((r) => {
      const parts = [`<Time>${new Date(r.timestamp).toISOString()}</Time>`]
      if (r.distanciaKm !== undefined) parts.push(`<DistanceMeters>${round1((r.distanciaKm - startKm) * 1000)}</DistanceMeters>`)
      if (r.pulso !== undefined) parts.push(`<HeartRateBpm><Value>${Math.round(r.pulso)}</Value></HeartRateBpm>`)
      parts.push(`<Cadence>${Math.min(254, Math.round(r.rpm))}</Cadence>`)
      parts.push(`<Extensions><ns3:TPX><ns3:Watts>${Math.round(r.watts)}</ns3:Watts></ns3:TPX></Extensions>`)
      return `          <Trackpoint>${parts.join('')}</Trackpoint>`
    })
    .join('\n')

  const heart = pulses.length
    ? `        <AverageHeartRateBpm><Value>${Math.round(pulses.reduce((a, b) => a + b, 0) / pulses.length)}</Value></AverageHeartRateBpm>
        <MaximumHeartRateBpm><Value>${Math.max(...pulses)}</Value></MaximumHeartRateBpm>
`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${start}</Id>
      <Lap StartTime="${start}">
        <TotalTimeSeconds>${seconds}</TotalTimeSeconds>
        <DistanceMeters>${meters}</DistanceMeters>
        <Calories>${calories}</Calories>
${heart}        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${points}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`
}

export const tcxFileName = (jsonName) => `${jsonName.replace(/\.json$/i, '')}.tcx`
