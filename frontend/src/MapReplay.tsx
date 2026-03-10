import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet-rotate' // Leaflet rotation plugin
import { gpx as parseGPX } from '@tmcw/togeojson'
import { DOMParser } from 'xmldom'

// Historical weather data from Open-Meteo API
interface HistoricalWeather {
  date: string
  temperature: number // Celsius
  windSpeed: number // km/h
  windDirection: number // degrees
  windGusts: number // km/h
  weatherCode: number
  precipitation: number // mm
}

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

// GPS logger offset from bow (as fraction of boat length)
// 420: GPS logger is 1/4 (25%) of boat length back from bow (3/4 from bow, 1/4 from stern)
// FJ: GPS logger is 1/3 (33.3%) of boat length back from bow (2/3 from bow, 1/3 from stern)
// Since our icons have bow at top, iconAnchor Y should be at this offset from the top
const GPS_OFFSET_FROM_BOW: Record<string, number> = {
  '420': 0.25,  // 25% from bow (top of image)
  'FJ': 0.333,  // 33.3% from bow (top of image)
}

// Boat dimensions for scaling (in meters)
// FJ (Flying Junior): 13'3" = 4.04m length, 4'11" = 1.5m beam
// 420 (Club 420): 13.75' = 4.19m length, 5.5' = 1.68m beam
const BOAT_DIMENSIONS: Record<string, { length: number; beam: number }> = {
  'FJ': { length: 4.04, beam: 1.5 },
  '420': { length: 4.19, beam: 1.68 },
}

// At higher zoom, each pixel represents less ground distance, so objects appear larger
function metersToPixels(meters: number, zoom: number): number {
  const pixelsPerMeter = (256 * Math.pow(2, zoom)) / 40075016
  return meters * pixelsPerMeter
}

// Create boat hull icon using PNG images with color tinting and rotation
// Returns HTML for use in L.divIcon
// anchorX, anchorY: the point in the icon that corresponds to the GPS coordinates
function createBoatIcon(boatType: string, color: string, pixelWidth: number, pixelHeight: number, rotation: number = 0, anchorX?: number, anchorY?: number): string {
  // PNG file path (served from public folder)
  const imageFile = boatType === '420' ? '/420-model.png' : '/fj-model.png'
  
  // The PNG images are oriented correctly, no rotation adjustment needed
  const adjustedRotation = rotation
  
  // Transform origin should be the anchor point (GPS location) so the boat rotates around that point
  // If anchor not provided, default to center
  const originX = anchorX !== undefined ? `${anchorX}px` : 'center'
  const originY = anchorY !== undefined ? `${anchorY}px` : 'center'
  
  // Use CSS mask to apply color to black silhouette:
  // The image is used as a mask (only opaque parts show)
  // Background-color shows through the mask
  const html = `
    <div style="
      width: ${pixelWidth}px; 
      height: ${pixelHeight}px; 
      transform: rotate(${adjustedRotation}deg);
      transform-origin: ${originX} ${originY};
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
function getCachedIcon(boatType: string, color: string, pixelWidth: number, pixelHeight: number, rotation: number, anchorX: number, anchorY: number): string {
  // Create a unique key based on boat type, color, size, rotation, and anchor (rounded to 5 degrees)
  const key = `${boatType}-${color}-${Math.round(pixelWidth)}-${Math.round(pixelHeight)}-${Math.round(rotation / 5) * 5}-${Math.round(anchorX)}-${Math.round(anchorY)}`
  if (!iconCache.has(key)) {
    iconCache.set(key, createBoatIcon(boatType, color, pixelWidth, pixelHeight, rotation, anchorX, anchorY))
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

// Get icon anchor point based on GPS logger offset
// This positions the GPS location at the correct point on the boat icon
// The anchor is the point in the icon that corresponds to the GPS coordinates on the map
// The CSS rotation will rotate around this anchor point
function getIconAnchor(boatType: string, iconSize: [number, number]): [number, number] {
  // GPS offset from bow as fraction of boat length (measured from bow toward stern)
  // 420: GPS at 1/4 (25%) from bow = 75% down from bow (top of image)
  // FJ: GPS at 1/3 (33.3%) from bow = 66.7% down from bow (top of image)
  const offsetFromBow = GPS_OFFSET_FROM_BOW[boatType] || GPS_OFFSET_FROM_BOW['FJ']
  
  // The GPS point is at this fraction down from the top (bow) of the image
  // In image coordinates: Y increases downward
  const gpsY = iconSize[1] * offsetFromBow
  const gpsX = iconSize[0] / 2  // Centered horizontally
  
  // The anchor is simply the GPS position in the icon
  // CSS rotation will rotate around this point
  return [gpsX, gpsY]
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
  // Fetch historical weather from Open-Meteo API
  const fetchHistoricalWeather = async (lat: number, lng: number, date: Date) => {
    try {
      setWeatherLoading(true)
      setWeatherError(null)
      
      const dateStr = date.toISOString().split('T')[0] // YYYY-MM-DD
      
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${dateStr}&end_date=${dateStr}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,weather_code`
      
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.hourly && data.hourly.time && data.hourly.time.length > 0) {
        // Get midday values (or first available)
        const middayIndex = Math.floor(data.hourly.time.length / 2)
        
        const weather: HistoricalWeather = {
          date: dateStr,
          temperature: data.hourly.temperature_2m?.[middayIndex] ?? 0,
          windSpeed: data.hourly.wind_speed_10m?.[middayIndex] ?? 0,
          windDirection: data.hourly.wind_direction_10m?.[middayIndex] ?? 0,
          windGusts: data.hourly.wind_gusts_10m?.[middayIndex] ?? 0,
          weatherCode: data.hourly.weather_code?.[middayIndex] ?? 0,
          precipitation: data.hourly.precipitation?.[middayIndex] ?? 0,
        }
        
        setHistoricalWeather(weather)
        return weather
      }
      
      throw new Error('No weather data available')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch weather'
      setWeatherError(errorMsg)
      console.error('Weather fetch error:', err)
      return null
    } finally {
      setWeatherLoading(false)
    }
  }
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
  // Boat labels shown on hover (not via toggle checkbox)
  
  // Marks state
  const [marks, setMarks] = useState<Mark[]>([])
  const [markMode, setMarkMode] = useState<'none' | 'course' | 'start' | 'finish' | 'move' | 'delete'>('none')
  const marksLayerRef = useRef<L.LayerGroup | null>(null)
  const markMarkersRef = useRef<Map<string, L.Marker>>(new Map())
  
  // Use ref to track markMode for click handler (avoids re-registering handler)
  const markModeRef = useRef(markMode)
  markModeRef.current = markMode
  
  // Color picker popup state
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [selectedBoatForColor, setSelectedBoatForColor] = useState<number | null>(null)
  const [colorPickerPosition, setColorPickerPosition] = useState<{ x: number; y: number } | null>(null)
  
  // Map rotation state
  const [mapBearing, setMapBearing] = useState(0)

  // Historical weather state
  const [historicalWeather, setHistoricalWeather] = useState<HistoricalWeather | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [weatherError, setWeatherError] = useState<string | null>(null)

  // Keep boats ref updated
  useEffect(() => {
    boatsRef.current = boats
  }, [boats])

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return

    // Type assertion to include leaflet-rotate options
    const mapOptions = {
      center: [38.9, -77.0], // Default to DC area
      zoom: 12,
      minZoom: 10,
      maxZoom: 22,
      zoomControl: true,
      rotate: true, // Enable leaflet-rotate plugin
      bearing: 0
    } as L.MapOptions

    mapRef.current = L.map(mapContainer.current, mapOptions)

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
    
    // Check if leaflet-rotate plugin extended L.Map (debug logging)
    setTimeout(() => {
      const hasRotation = typeof (mapRef.current as any).setBearing === 'function'
      console.log('Leaflet rotation plugin:', hasRotation ? 'loaded' : 'NOT loaded')
    }, 500)

    // Initialize marks layer
    marksLayerRef.current = L.layerGroup().addTo(mapRef.current)

    // Handle clicks for adding marks (only when not in move/delete mode and when mark mode is active)
    mapRef.current.on('click', (e: L.LeafletMouseEvent) => {
      const currentMarkMode = markModeRef.current
      
      // Don't add marks in move or delete mode
      if (currentMarkMode === 'move' || currentMarkMode === 'delete') return
      
      const { lat, lng } = e.latlng
      
      if (currentMarkMode === 'course') {
        // Add a course mark
        const newMark: Mark = {
          id: `mark-${Date.now()}`,
          lat,
          lng,
          type: 'course',
          label: `M${marks.filter(m => m.type === 'course').length + 1}`
        }
        setMarks(prev => [...prev, newMark])
      } else if (currentMarkMode === 'start') {
        // Add a start mark (can have up to 2)
        const existingStarts = marks.filter(m => m.type === 'start').length
        if (existingStarts >= 2) return // Max 2 start marks
        
        const newMark: Mark = {
          id: `start-${Date.now()}`,
          lat,
          lng,
          type: 'start',
          label: `Start ${existingStarts + 1}`
        }
        setMarks(prev => [...prev, newMark])
      } else if (currentMarkMode === 'finish') {
        // Add a finish mark (can have up to 2)
        const existingFinishes = marks.filter(m => m.type === 'finish').length
        if (existingFinishes >= 2) return // Max 2 finish marks
        
        const newMark: Mark = {
          id: `finish-${Date.now()}`,
          lat,
          lng,
          type: 'finish',
          label: `Finish ${existingFinishes + 1}`
        }
        setMarks(prev => [...prev, newMark])
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
          
          // Fetch historical weather for the center of the track on the date of the first point
          const center = bounds.getCenter()
          const firstTrack = tracks[0]
          const firstPointWithTime = firstTrack?.points.find(p => p.time)
          if (firstPointWithTime?.time) {
            fetchHistoricalWeather(center.lat, center.lng, firstPointWithTime.time)
          }
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
        
        // Get initial heading from first point with heading data, or default to 0
        const firstPointWithHeading = track.points.find(p => p.heading !== undefined)
        const initialHeading = firstPointWithHeading?.heading ?? 0
        
        // Create custom icon with boat hull shape (scaled to real-world dimensions)
        const iconSize = getIconSize(boatType, zoom)
        const iconAnchor = getIconAnchor(boatType, iconSize)
        const icon = L.divIcon({
          className: 'boat-marker',
          html: createBoatIcon(boatType, track.boat.color, iconSize[0], iconSize[1], initialHeading, iconAnchor[0], iconAnchor[1]),
          iconSize: iconSize,
          iconAnchor: iconAnchor,
        })
        
        track.marker = L.marker(latlngs[0], { icon }).addTo(mapRef.current!)
        
        // Add label tooltip on hover
        track.marker.bindTooltip(track.boat.name, {
          permanent: false,
          direction: 'top',
          opacity: 1
        })
        
        // Show tooltip on mouseover
        track.marker.on('mouseover', function(this: L.Marker) {
          this.openTooltip()
        })
        track.marker.on('mouseout', function(this: L.Marker) {
          this.closeTooltip()
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
        // Preserve current rotation instead of resetting to 0
        const currentRotation = rotationRef.current.get(track.boat.id) || 0
        // Add map bearing to boat rotation so boats rotate with the map
        const totalRotation = (currentRotation + mapBearing) % 360
        const iconSize = getIconSize(boatType, zoom)
        const iconAnchor = getIconAnchor(boatType, iconSize)
        const newIcon = L.divIcon({
          className: 'boat-marker',
          html: createBoatIcon(boatType, track.boat.color, iconSize[0], iconSize[1], totalRotation, iconAnchor[0], iconAnchor[1]),
          iconSize: iconSize,
          iconAnchor: iconAnchor,
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

  // Boat labels are shown on hover (handled in marker creation)

  // Update icon sizes when zoom changes
  useEffect(() => {
    boatTracks.forEach(track => {
      const marker = markersRef.current.get(track.boat.id)
      if (marker) {
        const boatType = track.boat.boat_type || 'FJ'
        // Get the current rotation (or default to 0 if not yet set)
        const rotation = rotationRef.current.get(track.boat.id) || 0
        // Add map bearing to boat rotation so boats rotate with the map
        const totalRotation = (rotation + mapBearing) % 360
        const iconSize = getIconSize(boatType, currentZoom)
        const iconAnchor = getIconAnchor(boatType, iconSize)
        const iconHtml = getCachedIcon(boatType, track.boat.color, iconSize[0], iconSize[1], totalRotation, iconAnchor[0], iconAnchor[1])
        const newIcon = L.divIcon({
          className: 'boat-marker',
          html: iconHtml,
          iconSize: iconSize,
          iconAnchor: iconAnchor,
        })
        marker.setIcon(newIcon)
      }
    })
  }, [currentZoom, boatTracks, mapBearing])

  // Render marks on map
  useEffect(() => {
    if (!marksLayerRef.current || !mapRef.current) return
    
    // Clear existing marks
    marksLayerRef.current.clearLayers()
    markMarkersRef.current.clear()
    
    // Add each mark to the layer
    // Mark size: 10px (1/2 instead of 1/3)
    const markSize = 10
    marks.forEach(mark => {
      let color: string
      let icon: L.DivIcon
      const half = markSize / 2
      
      if (mark.type === 'course') {
        color = '#ff6d01' // Orange for course marks
        icon = L.divIcon({
          className: 'mark-icon',
          html: `<div style="
            width: ${markSize}px; 
            height: ${markSize}px; 
            background: ${color}; 
            border: 1px solid white;
            border-radius: 50%;
            box-shadow: 0 1px 2px rgba(0,0,0,0.3);
          "></div>`,
          iconSize: [markSize, markSize],
          iconAnchor: [half, half],
        })
      } else if (mark.type === 'start') {
        color = '#34a853' // Green for start
        icon = L.divIcon({
          className: 'mark-icon',
          html: `<div style="
            width: 0; 
            height: 0; 
            border-left: ${half}px solid transparent;
            border-right: ${half}px solid transparent;
            border-bottom: ${markSize}px solid ${color};
          "></div>`,
          iconSize: [markSize, markSize],
          iconAnchor: [half, half],
        })
      } else {
        color = '#ea4335' // Red for finish
        icon = L.divIcon({
          className: 'mark-icon',
          html: `<div style="
            width: ${markSize}px; 
            height: ${markSize}px; 
            background: ${color}; 
            border: 1px solid white;
            border-radius: 1px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.3);
          "></div>`,
          iconSize: [markSize, markSize],
          iconAnchor: [half, half],
        })
      }
      
      const marker = L.marker([mark.lat, mark.lng], { 
        icon,
        draggable: markMode === 'move' // Only draggable in move mode
      })
      marker.addTo(marksLayerRef.current!)
      
      // Store marker reference
      markMarkersRef.current.set(mark.id, marker)
      
      // Handle drag events in move mode
      if (markMode === 'move') {
        marker.on('dragend', (e: L.LeafletEvent) => {
          const newLatLng = (e.target as L.Marker).getLatLng()
          setMarks(prev => prev.map(m => 
            m.id === mark.id ? { ...m, lat: newLatLng.lat, lng: newLatLng.lng } : m
          ))
        })
      }
      
      // Handle click to delete in delete mode
      if (markMode === 'delete') {
        marker.on('click', () => {
          setMarks(prev => prev.filter(m => m.id !== mark.id))
        })
      }
    })
    
    // Draw lines between start marks (if 2+), and between finish marks (if 2+)
    const startMarks = marks.filter(m => m.type === 'start')
    const finishMarks = marks.filter(m => m.type === 'finish')
    
    // Draw line between start mark 1 and start mark 2 (if both exist)
    if (startMarks.length > 1) {
      const line = L.polyline(
        [
          [startMarks[0].lat, startMarks[0].lng],
          [startMarks[1].lat, startMarks[1].lng]
        ],
        {
          color: '#34a853', // Green for start line
          weight: 2,
          dashArray: '5, 5',
          opacity: 0.8
        }
      )
      line.addTo(marksLayerRef.current!)
    }
    
    // Draw line between finish mark 1 and finish mark 2 (if both exist)
    if (finishMarks.length > 1) {
      const line2 = L.polyline(
        [
          [finishMarks[0].lat, finishMarks[0].lng],
          [finishMarks[1].lat, finishMarks[1].lng]
        ],
        {
          color: '#ea4335', // Red for finish line
          weight: 2,
          dashArray: '5, 5',
          opacity: 0.8
        }
      )
      line2.addTo(marksLayerRef.current!)
    }
  }, [marks, markMode])

  // Control map dragging based on mark mode
  useEffect(() => {
    if (!mapRef.current) return
    
    // Disable dragging when placing marks, moving marks, or deleting marks
    if (markMode === 'course' || markMode === 'start' || markMode === 'finish' || markMode === 'move' || markMode === 'delete') {
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
      // Add map bearing to boat rotation so boats rotate with the map
      const totalRotation = (rotation + mapBearing) % 360
      const iconSize = getIconSize(boatType, zoom)
      const iconAnchor = getIconAnchor(boatType, iconSize)
      const iconHtml = getCachedIcon(boatType, track.boat.color, iconSize[0], iconSize[1], totalRotation, iconAnchor[0], iconAnchor[1])
      const newIcon = L.divIcon({
        className: 'boat-marker',
        html: iconHtml,
        iconSize: iconSize,
        iconAnchor: iconAnchor,
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
  }, [currentTime, startTime, mapBearing])

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '600px' }}>
      <div style={{ flex: 1, minHeight: '500px', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
        <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
        
        {/* Historical Weather Display - Top Right */}
        <div style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          zIndex: 1000,
          background: 'white',
          padding: '10px 14px',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          minWidth: '120px'
        }}>
          {weatherLoading ? (
            <div style={{ fontSize: '12px', color: '#666' }}>Loading...</div>
          ) : weatherError ? (
            <div style={{ fontSize: '11px', color: '#ea4335' }}>Unavailable</div>
          ) : historicalWeather ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* Simple arrow pointing where wind is blowing TO */}
              <div style={{
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <div style={{
                  fontSize: '24px',
                  color: '#041E42',
                  transform: `rotate(${historicalWeather.windDirection + 180}deg)`,
                  lineHeight: 1
                }}>
                  ↑
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: '11px', color: '#666' }}>
                  {historicalWeather.date}
                </div>
                <div style={{ fontSize: '14px', color: '#333' }}>
                  {((historicalWeather.temperature * 9/5) + 32).toFixed(1)}°F
                </div>
                <div style={{ fontSize: '14px', color: '#333', fontWeight: 600 }}>
                  {historicalWeather.windSpeed.toFixed(1)} km/h
                </div>
                {historicalWeather.windGusts > 0 && (
                  <div style={{ fontSize: '11px', color: '#666' }}>
                    gusts {historicalWeather.windGusts.toFixed(1)} km/h
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: '11px', color: '#666' }}>No weather</div>
          )}
        </div>
        
        {/* Map Rotation Control - Top Left */}
        <div style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          zIndex: 1000,
          background: 'white',
          padding: '8px 12px',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px'
        }}>
          <div style={{ fontSize: '11px', color: '#666', fontWeight: 500 }}>Map Rotation</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="range"
              min={0}
              max={360}
              value={mapBearing}
              onChange={(e) => {
                const bearing = parseInt(e.target.value)
                setMapBearing(bearing)
                if (mapRef.current && (mapRef.current as any).setBearing) {
                  (mapRef.current as any).setBearing(bearing)
                }
              }}
              style={{ width: '100px', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '12px', fontWeight: 500, minWidth: '35px' }}>{mapBearing}°</span>
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              onClick={() => {
                setMapBearing(0)
                if (mapRef.current && (mapRef.current as any).setBearing) {
                  (mapRef.current as any).setBearing(0)
                }
              }}
              style={{
                padding: '2px 8px',
                fontSize: '10px',
                cursor: 'pointer',
                background: '#f8f9fa',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
            >
              Reset
            </button>
            {historicalWeather && (
              <button
                onClick={() => {
                  // Rotate map so wind blows DOWN the screen (from top to bottom)
                  // Wind direction = where wind is FROM
                  // Wind blows TO (windDirection + 180) mod 360
                  // We want "TO" direction to point down (south on screen)
                  // So: (windDirection + 180 - mapBearing) mod 360 = 180 (south)
                  // mapBearing = windDirection
                  // Actually simpler: rotate so north points to (windDirection - 90)
                  const windBearing = (270 - historicalWeather.windDirection + 360) % 360
                  setMapBearing(windBearing)
                  if (mapRef.current && (mapRef.current as any).setBearing) {
                    (mapRef.current as any).setBearing(windBearing)
                  }
                }}
                style={{
                  padding: '2px 8px',
                  fontSize: '10px',
                  cursor: 'pointer',
                  background: '#e3f2fd',
                  border: '1px solid #1a73e8',
                  borderRadius: '4px',
                  color: '#1a73e8'
                }}
                title={`Align map with wind (${historicalWeather.windDirection}°)`}
              >
                ↓ Wind
              </button>
            )}
          </div>
        </div>
      </div>
      
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
              onClick={() => setMarkMode(markMode === 'start' ? 'none' : 'start')}
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
              onClick={() => setMarkMode(markMode === 'finish' ? 'none' : 'finish')}
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
              onClick={() => setMarkMode(markMode === 'move' ? 'none' : 'move')}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                background: markMode === 'move' ? '#9334e6' : '#f8f9fa',
                color: markMode === 'move' ? 'white' : '#333',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
              title="Move mode: drag marks to reposition"
            >
              ↔ Move
            </button>
            <button
              onClick={() => setMarkMode(markMode === 'delete' ? 'none' : 'delete')}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                background: markMode === 'delete' ? '#ea4335' : '#f8f9fa',
                color: markMode === 'delete' ? 'white' : '#333',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
              title="Delete mode: click marks to remove them"
            >
              ✕ Delete
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
          
          {/* Boat colors - clickable to open popup - scrollable if many boats */}
          <div style={{ 
            borderLeft: '1px solid #ddd', 
            paddingLeft: '16px', 
            display: 'flex', 
            gap: '12px', 
            flexWrap: 'wrap',
            maxHeight: '120px',
            overflowY: 'auto',
            alignItems: 'center'
          }}>
            {boats.map(boat => {
              const track = boatTracks.find(t => t.boat.id === boat.id)
              const currentColor = track?.boat.color || boat.color
              
              return (
                <div 
                  key={boat.id} 
                  onClick={(e) => {
                    const rect = (e.target as HTMLElement).getBoundingClientRect()
                    // Open color picker upward (subtract popup height ~200px from top)
                    setColorPickerPosition({ x: rect.left, y: rect.top - 200 })
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