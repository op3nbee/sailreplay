import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { gpx as parseGPX } from '@tmcw/togeojson'
import { DOMParser } from 'xmldom'

// Georgetown-inspired color palette with 18 presets
const COLOR_PRESETS = [
  '#041E42', // Georgetown Blue
  '#8D817B', // Georgetown Gray
  '#1a73e8', // Blue
  '#ea4335', // Red
  '#34a853', // Green
  '#fbbc04', // Yellow
  '#9334e6', // Purple
  '#ff6d01', // Orange
  '#46bdc6', // Teal
  '#7b1fa2', // Deep Purple
  '#c2185b', // Pink
  '#00796b', // Teal Dark
  '#5d4037', // Brown
  '#455a64', // Blue Grey
  '#263238', // Dark Grey
  '#1565c0', // Blue 800
  '#2e7d32', // Green 800
  '#c62828', // Red 800
]

interface Boat {
  id: number
  name: string
  color: string
  boat_type?: string
}

// Boat dimensions for scaling (in meters)
// FJ (Flying Junior): 13'3" = 4.04m length, 4'11" = 1.5m beam
// 420 (Club 420): 13.9' = 4.24m length, 5.5' = 1.68m beam
const BOAT_DIMENSIONS: Record<string, { length: number; beam: number }> = {
  'FJ': { length: 4.04, beam: 1.5 },
  '420': { length: 4.24, beam: 1.68 },
}

// At higher zoom, each pixel represents less ground distance, so objects appear larger
function metersToPixels(meters: number, zoom: number): number {
  const pixelsPerMeter = (256 * Math.pow(2, zoom)) / 40075016
  return meters * pixelsPerMeter
}

// Create boat hull icon using PNG images with color tinting and rotation
// Returns HTML for use in L.divIcon
function createBoatIcon(boatType: string, color: string, pixelWidth: number, pixelHeight: number, rotation: number = 0): string {
  // PNG file path (served from public folder)
  const imageFile = boatType === '420' ? '/420-model.png' : '/fj-model.png'
  
  // The PNG images are oriented correctly, no rotation adjustment needed
  const adjustedRotation = rotation
  
  // Use CSS mask to apply color to black silhouette:
  // The image is used as a mask (only opaque parts show)
  // Background-color shows through the mask
  const html = `
    <div style="
      width: ${pixelWidth}px; 
      height: ${pixelHeight}px; 
      transform: rotate(${adjustedRotation}deg);
      transform-origin: center center;
      -webkit-mask-image: url('${imageFile}');
      -webkit-mask-size: contain;
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      mask-image: url('${imageFile}');
      mask-size: contain;
      mask-repeat: no-repeat;
      mask-position: center;
      background-color: ${color};
      border: none;
      margin: 0;
      padding: 0;
    "></div>
  `.trim()
  
  return html
}

// Icon cache to avoid recreating icons every frame
const iconCache = new Map<string, string>()
function getCachedIcon(boatType: string, color: string, pixelWidth: number, pixelHeight: number, rotation: number): string {
  // Create a unique key based on boat type, color, size, and rotation (rounded to 5 degrees)
  const key = `${boatType}-${color}-${Math.round(pixelWidth)}-${Math.round(pixelHeight)}-${Math.round(rotation / 5) * 5}`
  if (!iconCache.has(key)) {
    iconCache.set(key, createBoatIcon(boatType, color, pixelWidth, pixelHeight, rotation))
  }
  return iconCache.get(key)!
}

// Get icon size based on boat type and zoom level (returns [width, height] in pixels)
function getIconSize(boatType: string, zoom: number): [number, number] {
  const dimensions = BOAT_DIMENSIONS[boatType] || BOAT_DIMENSIONS['FJ']
  
  // Convert real-world dimensions to pixels at current zoom
  const pixelLength = metersToPixels(dimensions.length, zoom)
  const pixelBeam = metersToPixels(dimensions.beam, zoom)
  
  // Return [width, height] - PNG images are vertical (height > width)
  return [Math.round(pixelBeam), Math.round(pixelLength)]
}

interface TrackPoint {
  lat: number
  lng: number
  time: Date | null
  speed?: number
  heading?: number
}

// Simple moving average filter for smoothing heading changes


interface BoatTrack {
  boat: Boat
  points: TrackPoint[]
  polyline: L.Polyline | null
  marker: L.Marker | null
}

// Mark types
type MarkType = 'course' | 'start' | 'finish'

interface Mark {
  id: string
  lat: number
  lng: number
  type: MarkType
  label?: string
}

interface MapReplayProps {
  practiceId: number
  boats: Boat[]
  onBoatUpdate?: (boatId: number, updates: Partial<Boat>) => void
}

function MapReplay({ practiceId, boats, onBoatUpdate }: MapReplayProps) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const [boatTracks, setBoatTracks] = useState<BoatTrack[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState<number>(0)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [duration, setDuration] = useState(0)
  const [startTime, setStartTime] = useState<Date | null>(null)
  const [endTime, setEndTime] = useState<Date | null>(null)
  const [currentBoatSpeeds, setCurrentBoatSpeeds] = useState<Record<number, { speed: number; heading: number }>>({})
  const animationRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(0)
  const boatsRef = useRef(boats) // Keep track of current boats with updated colors
  const markersRef = useRef<Map<number, L.Marker>>(new Map())
  const polylinesRef = useRef<Map<number, L.Polyline>>(new Map()) // Store polylines separately to preserve across state updates
  const zoomRef = useRef<number>(12) // Track current zoom level for icon sizing
  const rotationRef = useRef<Map<number, number>>(new Map()) // Track current rotation per boat
  const [currentZoom, setCurrentZoom] = useState(12)
  const [showTracks, setShowTracks] = useState(true)
  
  // Marks state
  const [marks, setMarks] = useState<Mark[]>([])
  const [markMode, setMarkMode] = useState<'none' | 'course' | 'start' | 'finish' | 'edit'>('none')
  const [startLinePoints, setStartLinePoints] = useState<[number, number][]>([])
  const marksLayerRef = useRef<L.LayerGroup | null>(null)
  const startLineRef = useRef<L.Polyline | null>(null)
  const markMarkersRef = useRef<Map<string, L.Marker>>(new Map()) // Track mark markers for dragging
  
  // Color picker popup state
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [selectedBoatForColor, setSelectedBoatForColor] = useState<number | null>(null)
  const [colorPickerPosition, setColorPickerPosition] = useState<{ x: number; y: number } | null>(null)

  // Keep boats ref updated
  useEffect(() => {
    boatsRef.current = boats
  }, [boats])

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return

    mapRef.current = L.map(mapContainer.current, {
      center: [38.9, -77.0], // Default to DC area
      zoom: 12,
      minZoom: 10,
      maxZoom: 22,
      zoomControl: true
    })

    // Base layer - CartoDB Voyager (clean, reliable)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap contributors © CARTO',
      maxZoom: 20
    }).addTo(mapRef.current)

    // Add OpenSeaMap nautical overlay
    L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      attribution: '© OpenSeaMap',
      maxZoom: 18
    }).addTo(mapRef.current)

    // Track zoom changes for icon scaling
    mapRef.current.on('zoomend', () => {
      if (mapRef.current) {
        const zoom = Math.round(mapRef.current.getZoom())
        zoomRef.current = zoom
        setCurrentZoom(zoom)
      }
    })

    // Initialize marks layer
    marksLayerRef.current = L.layerGroup().addTo(mapRef.current)

    // Handle clicks for adding marks (only when not in edit mode and when mark mode is active)
    mapRef.current.on('click', (e: L.LeafletMouseEvent) => {
      // Don't add marks in edit mode - that mode is for dragging
      if (markMode === 'edit') return
      
      const { lat, lng } = e.latlng
      
      if (markMode === 'course') {
        // Add a course mark
        const newMark: Mark = {
          id: `mark-${Date.now()}`,
          lat,
          lng,
          type: 'course',
          label: `M${marks.filter(m => m.type === 'course').length + 1}`
        }
        setMarks(prev => [...prev, newMark])
      } else if (markMode === 'start' || markMode === 'finish') {
        // Add point to start/finish line (need 2 points)
        setStartLinePoints(prev => {
          const newPoints = [...prev, [lat, lng] as [number, number]]
          if (newPoints.length === 2) {
            // Both points collected - create marks and line
            const mark1: Mark = {
              id: `start-${Date.now()}-1`,
              lat: newPoints[0][0],
              lng: newPoints[0][1],
              type: 'start',
              label: 'Start'
            }
            const mark2: Mark = {
              id: `finish-${Date.now()}-2`,
              lat: newPoints[1][0],
              lng: newPoints[1][1],
              type: 'finish',
              label: 'Finish'
            }
            setMarks(prev => [...prev, mark1, mark2])
            return [] // Reset for next line
          }
          return newPoints
        })
      }
    })

    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
      }
    }
  }, [])

  // Load GPX tracks for all boats
  useEffect(() => {
    if (!boats.length) return

    const loadTracks = async () => {
      const tracks: BoatTrack[] = []

      for (const boat of boats) {
        try {
          console.log(`Loading GPX for boat ${boat.id} (${boat.name}), color: ${boat.color}`)
          const res = await fetch(`/api/practices/${practiceId}/boats/${boat.id}/gpx`)
          if (!res.ok) {
            console.error(`Failed to fetch GPX: ${res.status}`)
            continue
          }

          const gpxText = await res.text()
          console.log(`GPX data length: ${gpxText.length}`)
          
          const parser = new DOMParser()
          const gpxDoc = parser.parseFromString(gpxText, 'application/xml')
          const geojson = parseGPX(gpxDoc)
          
          console.log('GeoJSON properties:', JSON.stringify(geojson.features?.[0]?.properties).substring(0, 500))

          const points: TrackPoint[] = []
          
          if (geojson.features && geojson.features[0]) {
            const feature = geojson.features[0]
            const coords = (feature.geometry as any)?.coordinates
            const props = feature.properties as any
            
            // togeojson stores times in coordinateProperties.times
            const coordProps = props?.coordinateProperties
            const times = coordProps?.times

            if (coords && Array.isArray(coords)) {
              console.log(`Coords length: ${coords.length}`)
              console.log(`Times: ${times ? times.length + ' items' : 'NONE'}, first: ${times?.[0]}`)
              
              for (let i = 0; i < coords.length; i++) {
                const coord = coords[i]
                // GPX toGeoJSON gives [lng, lat] pairs
                let point: TrackPoint = {
                  lat: coord[1],
                  lng: coord[0],
                  time: null
                }

                // Parse time from coordinateProperties.times array
                if (times && times[i]) {
                  const timeStr = times[i]
                  if (typeof timeStr === 'string') {
                    point.time = new Date(timeStr)
                  } else if (timeStr instanceof Date) {
                    point.time = timeStr
                  }
                }

                // Calculate speed and heading from previous point
                if (i > 0 && point.time) {
                  const prevPoint = points[i-1]
                  if (prevPoint.time) {
                    const map = mapRef.current
                    const dist = map ? map.distance(
                      [prevPoint.lat, prevPoint.lng],
                      [point.lat, point.lng]
                    ) : 0
                    const timeDiff = (point.time.getTime() - prevPoint.time.getTime()) / 1000 // seconds
                    if (timeDiff > 0) {
                      point.speed = (dist / timeDiff) * 1.94384 // m/s to knots
                    }

                    // Heading: direction from previous to current point
                    const dLat = point.lat - prevPoint.lat
                    const dLng = point.lng - prevPoint.lng
                    point.heading = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360
                  }
                }

                points.push(point)
              }
            }

          }
          
          console.log(`Parsed ${points.length} points, ${points.filter(p => p.time).length} have times`)
          
          tracks.push({
            boat,
            points,
            polyline: null,
            marker: null
          })
        } catch (err) {
          console.error(`Failed to load GPX for boat ${boat.id}:`, err)
        }
      }

      // Calculate duration
      let minTimeVal: number | null = null
      let maxTimeVal: number | null = null
      
      tracks.forEach(track => {
        track.points.forEach(p => {
          if (p.time) {
            const pt = p.time.getTime()
            if (minTimeVal === null || pt < minTimeVal) minTimeVal = pt
            if (maxTimeVal === null || pt > maxTimeVal) maxTimeVal = pt
          }
        })
      })

      const minTime = minTimeVal ? new Date(minTimeVal) : null
      const maxTime = maxTimeVal ? new Date(maxTimeVal) : null
      
      setStartTime(minTime)
      setEndTime(maxTime)
      
      if (minTime && maxTime) {
        setDuration(maxTime.getTime() - minTime.getTime())
        setCurrentTime(0)
      }

      setBoatTracks(tracks)

      // Fit map to bounds
      if (mapRef.current && tracks.length > 0) {
        const allPoints = tracks.flatMap(t => t.points.map(p => [p.lat, p.lng] as [number, number]))
        if (allPoints.length > 0) {
          const bounds = L.latLngBounds(allPoints)
          mapRef.current.fitBounds(bounds, { padding: [50, 50] })
        }
      }
    }

    loadTracks()
  }, [practiceId]) // Only reload when practiceId changes, not when boats change

  // Draw tracks on map
  useEffect(() => {
    if (!mapRef.current || boatTracks.length === 0) return

    const newTracks = [...boatTracks]

    newTracks.forEach((track) => {
      if (track.polyline) {
        track.polyline.remove()
      }
      if (track.marker) {
        track.marker.remove()
        markersRef.current.delete(track.boat.id)
      }

      // Draw the full track as a thin line
      const latlngs = track.points.map(p => [p.lat, p.lng] as L.LatLngTuple)
      track.polyline = L.polyline(latlngs, {
        color: track.boat.color,
        weight: 2,
        opacity: 0.5
      })
      if (showTracks) {
        track.polyline.addTo(mapRef.current!)
      }
      // Store polyline in ref for later access (color updates, visibility toggles)
      polylinesRef.current.set(track.boat.id, track.polyline)

      // Add boat marker using custom SVG icon
      if (latlngs.length > 0) {
        const boatType = track.boat.boat_type || 'FJ'
        const zoom = mapRef.current ? Math.round(mapRef.current.getZoom()) : 12
        
        // Create custom icon with boat hull shape (scaled to real-world dimensions)
        const iconSize = getIconSize(boatType, zoom)
        const icon = L.divIcon({
          className: 'boat-marker',
          html: createBoatIcon(boatType, track.boat.color, iconSize[0], iconSize[1], 0),
          iconSize: iconSize,
          iconAnchor: [iconSize[0] / 2, iconSize[1] / 2],
        })
        
        track.marker = L.marker(latlngs[0], { icon }).addTo(mapRef.current!)
        
        track.marker.bindTooltip(track.boat.name, {
          permanent: false,
          direction: 'top'
        })
        
        markersRef.current.set(track.boat.id, track.marker)
      }
    })

    setBoatTracks(newTracks)
  }, [boatTracks.length]) // Only run on initial load or when boats are added/removed

  // Sync boat data (especially colors) from props when they change
  useEffect(() => {
    if (boatTracks.length === 0) return
    
    const boatMap = new Map(boats.map(b => [b.id, b]))
    
    setBoatTracks(prevTracks => prevTracks.map(track => {
      const updatedBoat = boatMap.get(track.boat.id)
      if (updatedBoat && updatedBoat.color !== track.boat.color) {
        return { ...track, boat: updatedBoat }
      }
      return track
    }))
  }, [boats]) // Run when boats prop changes (e.g., color updates)

  // Update boat colors and track visibility when they change
  useEffect(() => {
    if (!mapRef.current) return
    
    boatTracks.forEach(track => {
      const marker = markersRef.current.get(track.boat.id)
      if (marker) {
        const boatType = track.boat.boat_type || 'FJ'
        const zoom = zoomRef.current
        const iconSize = getIconSize(boatType, zoom)
        // Preserve current rotation instead of resetting to 0
        const currentRotation = rotationRef.current.get(track.boat.id) || 0
        const newIcon = L.divIcon({
          className: 'boat-marker',
          html: createBoatIcon(boatType, track.boat.color, iconSize[0], iconSize[1], currentRotation),
          iconSize: iconSize,
          iconAnchor: [iconSize[0] / 2, iconSize[1] / 2],
        })
        marker.setIcon(newIcon)
      }
      
      // Update polyline color and visibility using ref (preserves across state updates)
      const polyline = polylinesRef.current.get(track.boat.id)
      if (polyline) {
        polyline.setStyle({ 
          color: track.boat.color
        })
        // Add or remove from map based on showTracks
        if (showTracks && !mapRef.current?.hasLayer(polyline)) {
          polyline.addTo(mapRef.current!)
        } else if (!showTracks && mapRef.current?.hasLayer(polyline)) {
          polyline.remove()
        }
      }
    })
  }, [boatTracks, showTracks])

  // Update icon sizes when zoom changes
  useEffect(() => {
    boatTracks.forEach(track => {
      const marker = markersRef.current.get(track.boat.id)
      if (marker) {
        const boatType = track.boat.boat_type || 'FJ'
        const iconSize = getIconSize(boatType, currentZoom)
        // Get the current rotation (or default to 0 if not yet set)
        const rotation = rotationRef.current.get(track.boat.id) || 0
        const iconHtml = getCachedIcon(boatType, track.boat.color, iconSize[0], iconSize[1], rotation)
        const newIcon = L.divIcon({
          className: 'boat-marker',
          html: iconHtml,
          iconSize: iconSize,
          iconAnchor: [iconSize[0] / 2, iconSize[1] / 2],
        })
        marker.setIcon(newIcon)
      }
    })
  }, [currentZoom, boatTracks])

  // Render marks on map
  useEffect(() => {
    if (!marksLayerRef.current || !mapRef.current) return
    
    // Clear existing marks
    marksLayerRef.current.clearLayers()
    markMarkersRef.current.clear()
    
    // Add each mark to the layer
    marks.forEach(mark => {
      let color: string
      let icon: L.DivIcon
      
      if (mark.type === 'course') {
        color = '#ff6d01' // Orange for course marks
        icon = L.divIcon({
          className: 'mark-icon',
          html: `<div style="
            width: 20px; 
            height: 20px; 
            background: ${color}; 
            border: 2px solid white;
            border-radius: 50%;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
          "></div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        })
      } else if (mark.type === 'start') {
        color = '#34a853' // Green for start
        icon = L.divIcon({
          className: 'mark-icon',
          html: `<div style="
            width: 0; 
            height: 0; 
            border-left: 10px solid transparent;
            border-right: 10px solid transparent;
            border-bottom: 20px solid ${color};
          "></div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        })
      } else {
        color = '#ea4335' // Red for finish
        icon = L.divIcon({
          className: 'mark-icon',
          html: `<div style="
            width: 20px; 
            height: 20px; 
            background: ${color}; 
            border: 2px solid white;
            border-radius: 2px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
          "></div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        })
      }
      
      const marker = L.marker([mark.lat, mark.lng], { 
        icon,
        draggable: markMode === 'edit' // Only draggable in edit mode
      })
      marker.bindTooltip(mark.label || mark.type, { permanent: true, direction: 'top' })
      marker.addTo(marksLayerRef.current!)
      
      // Store marker reference
      markMarkersRef.current.set(mark.id, marker)
      
      // Handle drag events in edit mode
      if (markMode === 'edit') {
        marker.on('dragend', (e: L.LeafletEvent) => {
          const newLatLng = (e.target as L.Marker).getLatLng()
          setMarks(prev => prev.map(m => 
            m.id === mark.id ? { ...m, lat: newLatLng.lat, lng: newLatLng.lng } : m
          ))
        })
        
        // Add visual indicator that mark is draggable
        marker.bindTooltip(`${mark.label || mark.type} (drag to move)`, { 
          permanent: true, 
          direction: 'top',
          className: 'draggable-tooltip'
        })
      }
      
      // Make marker right-clickable to delete (only when not in edit mode)
      if (markMode !== 'edit') {
        marker.on('contextmenu', () => {
          setMarks(prev => prev.filter(m => m.id !== mark.id))
        })
      }
    })
    
    // Draw start/finish line if we have both types
    const startMarks = marks.filter(m => m.type === 'start')
    const finishMarks = marks.filter(m => m.type === 'finish')
    
    if (startMarks.length > 0 && finishMarks.length > 0) {
      // Draw line between first start and first finish
      const line = L.polyline(
        [
          [startMarks[0].lat, startMarks[0].lng],
          [finishMarks[0].lat, finishMarks[0].lng]
        ],
        {
          color: '#041E42',
          weight: 3,
          dashArray: '10, 5',
          opacity: 0.8
        }
      )
      line.addTo(marksLayerRef.current!)
    }
  }, [marks])

  // Show/hide start line preview while clicking
  useEffect(() => {
    if (!mapRef.current || !marksLayerRef.current) return
    
    // Remove existing preview
    if (startLineRef.current) {
      startLineRef.current.remove()
      startLineRef.current = null
    }
    
    if (startLinePoints.length > 0 && (markMode === 'start' || markMode === 'finish')) {
      startLineRef.current = L.polyline(
        startLinePoints.map(p => [p[0], p[1]] as L.LatLngTuple),
        {
          color: '#041E42',
          weight: 3,
          dashArray: '5, 5',
          opacity: 0.5
        }
      )
      startLineRef.current.addTo(mapRef.current)
    }
  }, [startLinePoints, markMode])

  // Control map dragging based on mark mode
  useEffect(() => {
    if (!mapRef.current) return
    
    // Disable dragging when in any mark mode (except 'none' and 'edit' - edit allows dragging marks)
    if (markMode === 'course' || markMode === 'start' || markMode === 'finish') {
      mapRef.current.dragging.disable()
      mapRef.current.scrollWheelZoom.disable()
      mapRef.current.doubleClickZoom.disable()
    } else {
      mapRef.current.dragging.enable()
      mapRef.current.scrollWheelZoom.enable()
      mapRef.current.doubleClickZoom.enable()
    }
  }, [markMode])

  // Playback animation
  useEffect(() => {
    if (!isPlaying || !startTime || !endTime) return

    const animate = (timestamp: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = timestamp
      
      const delta = (timestamp - lastTimeRef.current) * playbackSpeed
      lastTimeRef.current = timestamp

      setCurrentTime(prev => {
        const newTime = prev + delta
        if (newTime >= duration) {
          setIsPlaying(false)
          return duration
        }
        return newTime
      })

      animationRef.current = requestAnimationFrame(animate)
    }

    lastTimeRef.current = 0
    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [isPlaying, playbackSpeed, duration, startTime, endTime])

  // Update boat positions based on current time with interpolation
  useEffect(() => {
    if (!startTime || boatTracks.length === 0) return

    const currentTimestamp = startTime.getTime() + currentTime
    const newSpeeds: Record<number, { speed: number; heading: number }> = {}

    const newTracks = boatTracks.map(track => {
      const marker = markersRef.current.get(track.boat.id)
      if (!marker) return track

      // Find the two points to interpolate between
      let prevPoint: TrackPoint | null = null
      let nextPoint: TrackPoint | null = null

      for (let i = 0; i < track.points.length; i++) {
        const p = track.points[i]
        if (!p.time) continue

        const pointTime = p.time.getTime()
        
        if (pointTime <= currentTimestamp) {
          prevPoint = p
          nextPoint = track.points[i + 1]?.time && track.points[i + 1].time!.getTime() > currentTimestamp 
            ? track.points[i + 1] 
            : null
        } else {
          break
        }
      }

      // Interpolate position between prevPoint and nextPoint
      let displayPoint: TrackPoint
      
      if (prevPoint && nextPoint && prevPoint.time && nextPoint.time) {
        const prevTime = prevPoint.time.getTime()
        const nextTime = nextPoint.time.getTime()
        const t = (currentTimestamp - prevTime) / (nextTime - prevTime)
        
        // Linear interpolation for lat/lng
        const lat = prevPoint.lat + (nextPoint.lat - prevPoint.lat) * t
        const lng = prevPoint.lng + (nextPoint.lng - prevPoint.lng) * t
        
        // Linear interpolation for speed (handle undefined)
        const speed = (prevPoint.speed ?? 0) + ((nextPoint.speed ?? 0) - (prevPoint.speed ?? 0)) * t
        
        // Heading: interpolate over first half of tick, then hold target
        const prevHeading = prevPoint.heading ?? 0
        const nextHeading = nextPoint.heading ?? 0
        const headingDiff = ((nextHeading - prevHeading + 540) % 360) - 180
        const headingT = Math.min(t * 4, 1) // Complete heading change in first 1/4 of tick
        const displayHeading = (prevHeading + headingDiff * headingT + 360) % 360
        
        displayPoint = { lat, lng, time: null, speed, heading: displayHeading }
      } else {
        displayPoint = prevPoint || track.points[0]
      }

      // Update marker position
      marker.setLatLng([displayPoint.lat, displayPoint.lng])

      // Use cached icon with rotation (much faster than creating new icons)
      // Use zoomRef for the current animation frame to get correct size
      const boatType = track.boat.boat_type || 'FJ'
      const zoom = zoomRef.current
      
      // Use interpolated heading for smooth rotation
      const rotation = displayPoint.heading || 0
      rotationRef.current.set(track.boat.id, rotation) // Store for zoom updates
      const iconSize = getIconSize(boatType, zoom)
      const iconHtml = getCachedIcon(boatType, track.boat.color, iconSize[0], iconSize[1], rotation)
      const newIcon = L.divIcon({
        className: 'boat-marker',
        html: iconHtml,
        iconSize: iconSize,
        iconAnchor: [iconSize[0] / 2, iconSize[1] / 2],
      })
      marker.setIcon(newIcon)

      // Update tooltip with speed/heading
      const speed = displayPoint.speed?.toFixed(1) || '--'
      const heading = displayPoint.heading?.toFixed(0) || '--'
      marker.setTooltipContent(`${track.boat.name}<br>${speed} kts<br>${heading}°`)

      // Store current speed for display panel
      if (displayPoint.speed) {
        newSpeeds[track.boat.id] = {
          speed: displayPoint.speed,
          heading: displayPoint.heading || 0
        }
      }

      return { ...track }
    })

    setBoatTracks(newTracks)
    setCurrentBoatSpeeds(newSpeeds)
  }, [currentTime, startTime])

  const togglePlay = () => {
    if (currentTime >= duration) {
      setCurrentTime(0)
      lastTimeRef.current = 0  // Reset timing when restarting
    }
    setIsPlaying(!isPlaying)
  }

  const handleTimelineChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentTime(parseFloat(e.target.value))
  }

  const formatTime = (ms: number) => {
    if (!startTime) return '00:00'
    const date = new Date(startTime.getTime() + ms)
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  // Handle color change - update local state immediately
  const handleColorChange = (boatId: number, newColor: string) => {
    // Update local state for immediate visual feedback
    setBoatTracks(prev => prev.map(bt => 
      bt.boat.id === boatId 
        ? { ...bt, boat: { ...bt.boat, color: newColor } }
        : bt
    ))
    
    // Notify parent to save to backend
    onBoatUpdate?.(boatId, { color: newColor })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div ref={mapContainer} style={{ flex: 1, minHeight: '500px', borderRadius: '8px', overflow: 'hidden' }} />
      
      {/* Speed Display Panel */}
      <div style={{ 
        display: 'flex', 
        gap: '16px', 
        marginTop: '16px',
        padding: '12px 16px',
        background: '#f8f9fa',
        borderRadius: '8px',
        border: '1px solid #e0e0e0',
        flexWrap: 'wrap'
      }}>
        <div style={{ fontWeight: 500, color: '#666', marginRight: '8px' }}>Current:</div>
        {boatTracks.map(track => {
          const speedData = currentBoatSpeeds[track.boat.id]
          return (
            <div key={track.boat.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ 
                width: '10px', 
                height: '10px', 
                borderRadius: '50%', 
                background: track.boat.color 
              }} />
              <span style={{ fontSize: '13px', fontWeight: 500 }}>{track.boat.name}:</span>
              <span style={{ fontSize: '14px', color: '#2e7d32', fontWeight: 600 }}>
                {speedData ? `${speedData.speed.toFixed(1)} kts` : '-- kts'}
              </span>
              <span style={{ fontSize: '12px', color: '#666' }}>
                @ {speedData ? `${speedData.heading.toFixed(0)}°` : '--'}
              </span>
            </div>
          )
        })}
      </div>

      <div style={{ 
        padding: '16px', 
        background: 'white', 
        borderRadius: '8px', 
        marginTop: '16px',
        border: '1px solid #e0e0e0'
      }}>
        {/* Timeline */}
        <div style={{ marginBottom: '12px' }}>
          <input
            type="range"
            min={0}
            max={duration}
            value={currentTime}
            onChange={handleTimelineChange}
            style={{ width: '100%', cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666' }}>
            <span>{formatTime(0)}</span>
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
          <button
            onClick={togglePlay}
            disabled={duration === 0}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              cursor: duration === 0 ? 'not-allowed' : 'pointer',
              background: isPlaying ? '#ea4335' : '#2e7d32',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              fontWeight: 500,
              opacity: duration === 0 ? 0.5 : 1
            }}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '14px', color: '#666' }}>Speed:</span>
            {[0.5, 1, 2, 4].map(speed => (
              <button
                key={speed}
                onClick={() => setPlaybackSpeed(speed)}
                style={{
                  padding: '6px 12px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  background: playbackSpeed === speed ? '#4285f4' : '#f8f9fa',
                  color: playbackSpeed === speed ? 'white' : '#333',
                  border: '1px solid #ddd',
                  borderRadius: '4px'
                }}
              >
                {speed}x
              </button>
            ))}
          </div>
        </div>

        {/* Boat Legend with Controls */}
        <div style={{ display: 'flex', gap: '16px', marginTop: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={showTracks}
              onChange={(e) => setShowTracks(e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            Show GPS Tracks
          </label>
          
          {/* Mark Controls */}
          <div style={{ borderLeft: '1px solid #ddd', paddingLeft: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: '#666' }}>Marks:</span>
            <button
              onClick={() => setMarkMode(markMode === 'course' ? 'none' : 'course')}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                background: markMode === 'course' ? '#ff6d01' : '#f8f9fa',
                color: markMode === 'course' ? 'white' : '#333',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
              title="Click map to add course marks (orange)"
            >
              ⬤ Course
            </button>
            <button
              onClick={() => { setMarkMode(markMode === 'start' ? 'none' : 'start'); setStartLinePoints([]) }}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                background: markMode === 'start' ? '#34a853' : '#f8f9fa',
                color: markMode === 'start' ? 'white' : '#333',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
              title="Click two points to set start line (green)"
            >
              ▲ Start
            </button>
            <button
              onClick={() => { setMarkMode(markMode === 'finish' ? 'none' : 'finish'); setStartLinePoints([]) }}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                background: markMode === 'finish' ? '#ea4335' : '#f8f9fa',
                color: markMode === 'finish' ? 'white' : '#333',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
              title="Click two points to set finish line (red)"
            >
              ■ Finish
            </button>
            <button
              onClick={() => setMarkMode(markMode === 'edit' ? 'none' : 'edit')}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                background: markMode === 'edit' ? '#9334e6' : '#f8f9fa',
                color: markMode === 'edit' ? 'white' : '#333',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
              title="Edit mode: drag marks to move, drag to trash to delete"
            >
              ✎ Edit
            </button>
            {marks.length > 0 && (
              <button
                onClick={() => setMarks([])}
                style={{
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  background: '#f8f9fa',
                  color: '#666',
                  border: '1px solid #ddd',
                  borderRadius: '4px'
                }}
              >
                Clear
              </button>
            )}
          </div>
          
          {/* Trash Bin - only show in edit mode */}
          {markMode === 'edit' && (
            <div 
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const markId = e.dataTransfer.getData('markId')
                if (markId) {
                  setMarks(prev => prev.filter(m => m.id !== markId))
                }
              }}
              style={{
                padding: '8px 12px',
                background: '#ffebee',
                border: '2px dashed #ef5350',
                borderRadius: '8px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                color: '#c62828'
              }}
              title="Drag marks here to delete"
            >
              🗑️ Drop to Delete
            </div>
          )}
          
          {/* Boat colors - clickable to open popup */}
          <div style={{ borderLeft: '1px solid #ddd', paddingLeft: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {boats.map(boat => {
              const track = boatTracks.find(t => t.boat.id === boat.id)
              const currentColor = track?.boat.color || boat.color
              
              return (
                <div 
                  key={boat.id} 
                  onClick={(e) => {
                    const rect = (e.target as HTMLElement).getBoundingClientRect()
                    setColorPickerPosition({ x: rect.left, y: rect.bottom + 8 })
                    setSelectedBoatForColor(boat.id)
                    setShowColorPicker(true)
                  }}
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '6px',
                    cursor: 'pointer',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    background: selectedBoatForColor === boat.id ? '#e3f2fd' : 'transparent'
                  }}
                >
                  <span
                    style={{ 
                      width: '16px', 
                      height: '16px', 
                      background: currentColor, 
                      borderRadius: '3px',
                      border: '1px solid rgba(0,0,0,0.2)'
                    }}
                  />
                  <span style={{ fontSize: '13px' }}>{boat.name}</span>
                  {boat.boat_type && (
                    <span style={{ background: '#e3f2fd', padding: '2px 6px', borderRadius: '8px', fontSize: '10px', color: '#1565c0' }}>
                      {boat.boat_type}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        
        {/* Color Picker Popup */}
        {showColorPicker && selectedBoatForColor !== null && colorPickerPosition && (
          <div 
            style={{
              position: 'fixed',
              left: colorPickerPosition.x,
              top: colorPickerPosition.y,
              background: 'white',
              border: '1px solid #ddd',
              borderRadius: '8px',
              padding: '12px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              zIndex: 1000,
              display: 'grid',
              gridTemplateColumns: 'repeat(6, 1fr)',
              gap: '6px'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {COLOR_PRESETS.map((color) => {
              const track = boatTracks.find(t => t.boat.id === selectedBoatForColor)
              const currentColor = track?.boat.color || boats.find(b => b.id === selectedBoatForColor)?.color
              
              return (
                <button
                  key={color}
                  onClick={() => {
                    handleColorChange(selectedBoatForColor, color)
                    setShowColorPicker(false)
                    setSelectedBoatForColor(null)
                  }}
                  style={{
                    width: '28px',
                    height: '28px',
                    padding: 0,
                    border: currentColor === color ? '2px solid #000' : '1px solid #ccc',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    background: color,
                  }}
                  title={color}
                />
              )
            })}
            <button
              onClick={() => {
                setShowColorPicker(false)
                setSelectedBoatForColor(null)
              }}
              style={{
                gridColumn: 'span 6',
                padding: '6px',
                fontSize: '11px',
                cursor: 'pointer',
                background: '#f8f9fa',
                border: '1px solid #ddd',
                borderRadius: '4px',
                marginTop: '4px'
              }}
            >
              Cancel
            </button>
          </div>
        )}
        
        {/* Close color picker when clicking elsewhere */}
        {showColorPicker && (
          <div 
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
            onClick={() => {
              setShowColorPicker(false)
              setSelectedBoatForColor(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

export default MapReplay