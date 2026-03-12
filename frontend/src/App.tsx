import { useState, useEffect, useRef } from 'react'
import MapReplay from './MapReplay'

interface Practice {
  id: number
  name: string
  date: string
  location: string
  boat_count: number
  created_at: string
}

interface Boat {
  id: number
  name: string
  gpx_filename: string
  color: string
  has_track: number
  boat_type?: string
}

interface PracticeDetail extends Practice {
  boats: Boat[]
}

function App() {
  const [loading, setLoading] = useState(true)
  const [practices, setPractices] = useState<Practice[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [selectedPractice, setSelectedPractice] = useState<PracticeDetail | null>(null)

  useEffect(() => {
    // Skip auth - load practices directly (local access mode)
    loadPractices()
    setLoading(false)
  }, [])

  const loadPractices = () => {
    fetch('/api/practices')
      .then(res => res.json())
      .then(data => setPractices(data))
      .catch(console.error)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <p>Loading...</p>
      </div>
    )
  }

  // Skip auth - always show main app (local access mode)
  // if (!user) { ... login screen removed ... }

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, sans-serif', maxWidth: '1200px', margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', borderBottom: '1px solid #eee', paddingBottom: '15px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '24px' }}>⛵ SailReplay Georgetown</h1>
          <p style={{ margin: '5px 0 0', color: '#666', fontSize: '14px' }}>Track and replay your sailing practices</p>
        </div>
        <div style={{ color: '#666', fontSize: '13px' }}>
          Local Mode
        </div>
      </header>
      
      <main>
        {!showCreate && !selectedPractice && (
          <>
            <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>Your Practices</h2>
              <button 
                onClick={() => setShowCreate(true)}
                style={{ 
                  padding: '10px 20px', 
                  fontSize: '14px', 
                  cursor: 'pointer',
                  background: '#2e7d32',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  fontWeight: 500
                }}
              >
                + Create New Practice
              </button>
            </div>
            
            {practices.length === 0 ? (
              <div style={{ background: '#f8f9fa', padding: '40px', borderRadius: '8px', textAlign: 'center' }}>
                <p style={{ color: '#666', marginBottom: '20px' }}>No practices yet. Create your first one!</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
                {practices.map(practice => (
                  <div 
                    key={practice.id}
                    onClick={() => {
                      fetch(`/api/practices/${practice.id}`)
                        .then(res => res.json())
                        .then(data => setSelectedPractice(data))
                    }}
                    style={{ 
                      padding: '20px', 
                      background: 'white', 
                      border: '1px solid #e0e0e0', 
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'box-shadow 0.2s'
                    }}
                  >
                    <h3 style={{ margin: '0 0 8px', fontSize: '18px' }}>{practice.name}</h3>
                    <p style={{ margin: '0 0 8px', color: '#666', fontSize: '14px' }}>{practice.date}</p>
                    {practice.location && (
                      <p style={{ margin: '0', color: '#666', fontSize: '13px' }}>📍 {practice.location}</p>
                    )}
                    <p style={{ margin: '8px 0 0', color: '#4285f4', fontSize: '13px' }}>
                      {practice.boat_count} boat{practice.boat_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        
        {showCreate && (
          <CreatePractice 
            onClose={() => setShowCreate(false)}
            onCreated={(id) => {
              setShowCreate(false)
              loadPractices()
              fetch(`/api/practices/${id}`)
                .then(res => res.json())
                .then(data => setSelectedPractice(data))
            }}
          />
        )}
        
        {selectedPractice && (
          <PracticeView 
            practice={selectedPractice}
            onBack={() => setSelectedPractice(null)}
          />
        )}
      </main>
    </div>
  )
}

function CreatePractice({ onClose, onCreated }: { onClose: () => void, onCreated: (id: number) => void }) {
  const [name, setName] = useState('')
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [location, setLocation] = useState('')
  const [gpxFiles, setGpxFiles] = useState<File[]>([])
  const [boatNames, setBoatNames] = useState<string[]>([])
  const [boatTypes, setBoatTypes] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files)
      setGpxFiles(files)
      // Auto-generate boat names and types based on file count
      setBoatNames(files.map((_, i) => `Boat ${i + 1}`))
      setBoatTypes(files.map(() => 'FJ'))
    }
  }

  const updateBoatName = (index: number, value: string) => {
    const updated = [...boatNames]
    updated[index] = value
    setBoatNames(updated)
  }

  const updateBoatType = (index: number, value: string) => {
    const updated = [...boatTypes]
    updated[index] = value
    setBoatTypes(updated)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)

    const formData = new FormData()
    formData.append('name', name)
    formData.append('date', date)
    if (location) formData.append('location', location)
    
    gpxFiles.forEach(file => {
      formData.append('gpx_files', file)
    })
    
    boatNames.forEach(name => {
      formData.append('boat_names', name)
    })

    boatTypes.forEach(type => {
      formData.append('boat_types', type)
    })

    try {
      const res = await fetch('/api/practices', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      })
      
      if (!res.ok) {
        const err = await res.json()
        alert('Error: ' + JSON.stringify(err))
        return
      }
      
      const result = await res.json()
      onCreated(result.id)
    } catch (err) {
      alert('Error creating practice')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ background: 'white', borderRadius: '8px', padding: '30px', border: '1px solid #e0e0e0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ margin: 0 }}>Create New Practice</h2>
        <button onClick={onClose} style={{ padding: '8px 16px', cursor: 'pointer', background: 'transparent', border: '1px solid #ddd', borderRadius: '4px' }}>Cancel</button>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500 }}>Practice Name *</label>
          <input 
            type="text" 
            value={name} 
            onChange={e => setName(e.target.value)}
            placeholder="e.g., Tuesday Drills"
            required
            style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500 }}>Date *</label>
            <input 
              type="date" 
              value={date} 
              onChange={e => setDate(e.target.value)}
              required
              style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500 }}>Location</label>
            <input 
              type="text" 
              value={location} 
              onChange={e => setLocation(e.target.value)}
              placeholder="e.g., Potomac River"
              style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ddd', borderRadius: '4px', boxSizing: 'border-box' }}
            />
          </div>
        </div>

        <div style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500 }}>Upload GPX Files</label>
          <p style={{ margin: '0 0 10px', color: '#666', fontSize: '13px' }}>Select GPX files from your GPS logger or device</p>
          
          {/* Hidden file input triggered by button */}
          <input 
            ref={fileInputRef}
            type="file" 
            accept=".gpx"
            multiple
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          
          {/* Button to trigger file input */}
          <button 
            type="button"
            onClick={() => {
              console.log('Clicking file input...')
              fileInputRef.current?.click()
            }}
            style={{ 
              padding: '12px 20px', 
              cursor: 'pointer',
              background: '#f8f9fa',
              border: '2px dashed #ddd',
              borderRadius: '4px',
              fontSize: '14px',
              width: '100%',
              boxSizing: 'border-box',
              marginBottom: '8px'
            }}
          >
            📂 Select GPX Files
          </button>
          
          {gpxFiles.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <p style={{ margin: '0 0 10px', fontWeight: 500 }}>{gpxFiles.length} file(s) selected</p>
              
              {gpxFiles.map((_, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', padding: '10px', background: '#f8f9fa', borderRadius: '4px' }}>
                  <span style={{ flex: 1, fontSize: '14px' }}>{gpxFiles[i].name}</span>
                  <input 
                    type="text"
                    value={boatNames[i] || ''}
                    onChange={e => updateBoatName(i, e.target.value)}
                    placeholder="Boat name"
                    style={{ width: '120px', padding: '8px', fontSize: '13px', border: '1px solid #ddd', borderRadius: '4px' }}
                  />
                  <select
                    value={boatTypes[i] || 'FJ'}
                    onChange={e => updateBoatType(i, e.target.value)}
                    style={{ width: '100px', padding: '8px', fontSize: '13px', border: '1px solid #ddd', borderRadius: '4px' }}
                  >
                    <option value="FJ">FJ</option>
                    <option value="420">420</option>
                  </select>
                </div>
              ))}
              
              <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#666' }}>
                💡 Tip: FJ = Flying Junior (13'3"), 420 = Club 420 (13'9")
              </p>
            </div>
          )}
        </div>

        <button 
          type="submit"
          disabled={saving || !name || !date}
          style={{ 
            padding: '12px 24px', 
            fontSize: '16px', 
            cursor: saving ? 'not-allowed' : 'pointer',
            background: saving ? '#ccc' : '#2e7d32',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontWeight: 500
          }}
        >
          {saving ? 'Creating...' : 'Create Practice'}
        </button>
      </form>
    </div>
  )
}

function PracticeView({ practice, onBack }: { practice: PracticeDetail, onBack: () => void }) {
  const [deleting, setDeleting] = useState(false)
  // Local state for boats - gets updated when colors change
  const [boats, setBoats] = useState(practice.boats)

  // Sync boats when practice changes
  useEffect(() => {
    setBoats(practice.boats)
  }, [practice.boats])

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete "${practice.name}"? This will remove all boats and GPX data.`)) {
      return
    }
    
    setDeleting(true)
    try {
      const res = await fetch(`/api/practices/${practice.id}`, {
        method: 'DELETE',
        credentials: 'include'
      })
      
      if (!res.ok) {
        alert('Error deleting practice')
        return
      }
      
      onBack()
    } catch (err) {
      alert('Error deleting practice')
      console.error(err)
    } finally {
      setDeleting(false)
    }
  }

  const handleBoatUpdate = async (boatId: number, updates: Partial<Boat>) => {
    try {
      const res = await fetch(`/api/practices/${practice.id}/boats/${boatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
        credentials: 'include'
      })
      
      if (!res.ok) {
        console.error('Failed to update boat')
        return
      }
      
      // Update local state with the new boat data
      setBoats(prev => prev.map(b => b.id === boatId ? { ...b, ...updates } : b))
    } catch (err) {
      console.error('Error updating boat:', err)
    }
  }

  return (
    <div>
      <button 
        onClick={onBack}
        style={{ marginBottom: '20px', padding: '8px 16px', cursor: 'pointer', background: 'transparent', border: '1px solid #ddd', borderRadius: '4px' }}
      >
        ← Back to Practices
      </button>
      
      <div style={{ background: 'white', borderRadius: '8px', padding: '24px', border: '1px solid #e0e0e0', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ margin: '0 0 10px' }}>{practice.name}</h2>
            <p style={{ margin: '0 0 10px', color: '#666' }}>{practice.date} • {practice.location || 'No location'}</p>
          </div>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{ 
              padding: '8px 16px', 
              cursor: deleting ? 'not-allowed' : 'pointer',
              background: deleting ? '#ccc' : '#d32f2f',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              fontSize: '13px'
            }}
          >
            {deleting ? 'Deleting...' : '🗑️ Delete'}
          </button>
        </div>
      </div>
      
      {boats.length > 0 && boats[0].has_track > 0 ? (
        <MapReplay practiceId={practice.id} boats={boats} onBoatUpdate={handleBoatUpdate} />
      ) : (
        <div style={{ background: '#f8f9fa', padding: '40px', borderRadius: '8px', textAlign: 'center' }}>
          <p style={{ color: '#666' }}>No GPX data available for this practice.</p>
          <p style={{ fontSize: '14px', color: '#999' }}>Upload GPX files when creating a practice to see the replay.</p>
        </div>
      )}
    </div>
  )
}

export default App
