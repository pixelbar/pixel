import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  distance: number
  targetAngle: number
  targetDistance: number
  color: string
  size: number
  originalAngle: number
  originalDistance: number
}

export function AnimatedLogo() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationId: number
    let particles: Particle[] = []
    
    const centerX = canvas.width / 2
    const centerY = canvas.height / 2

    // Vibrant rainbow colors for the pixelated swirl
    const colors = [
      '#FF1493', // Deep pink
      '#FF69B4', // Hot pink
      '#BA55D3', // Medium orchid (purple)
      '#9370DB', // Medium purple
      '#4169E1', // Royal blue
      '#1E90FF', // Dodger blue
      '#00CED1', // Dark turquoise
      '#00FA9A', // Medium spring green
      '#ADFF2F', // Green yellow
      '#FFD700', // Gold
      '#FFA500', // Orange
      '#FF6347', // Tomato
    ]

    // Initialize particles in a spiral pattern
    const initParticles = () => {
      particles = []
      const spirals = 8
      const particlesPerSpiral = 40
      
      for (let spiral = 0; spiral < spirals; spiral++) {
        for (let i = 0; i < particlesPerSpiral; i++) {
          const t = i / particlesPerSpiral
          const angle = (spiral * Math.PI * 2 / spirals) + (t * Math.PI * 6)
          const distance = 50 + t * 250
          
          const colorIndex = Math.floor((spiral + t * 3) * colors.length / (spirals + 3)) % colors.length
          
          particles.push({
            x: centerX + Math.cos(angle) * distance,
            y: centerY + Math.sin(angle) * distance,
            vx: 0,
            vy: 0,
            angle,
            distance,
            targetAngle: angle,
            targetDistance: distance,
            originalAngle: angle,
            originalDistance: distance,
            color: colors[colorIndex],
            size: 3 + Math.random() * 3,
          })
        }
      }
    }

    // Physics simulation with gravity toward center
    const updateParticles = (time: number) => {
      const GRAVITY = 0.3
      const ROTATION_SPEED = 0.001
      const DAMPING = 0.92
      const ORBIT_STRENGTH = 0.05

      particles.forEach((p) => {
        // Calculate vector to center
        const dx = centerX - p.x
        const dy = centerY - p.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        
        // Gravity pull toward center
        if (dist > 40) {
          const force = GRAVITY * (dist / 100)
          p.vx += (dx / dist) * force
          p.vy += (dy / dist) * force
        }

        // Orbital motion
        const currentAngle = Math.atan2(p.y - centerY, p.x - centerX)
        p.targetAngle = p.originalAngle + time * ROTATION_SPEED
        
        // Tangential velocity for orbit
        const orbitalVx = -Math.sin(currentAngle) * ORBIT_STRENGTH * p.originalDistance / 100
        const orbitalVy = Math.cos(currentAngle) * ORBIT_STRENGTH * p.originalDistance / 100
        
        p.vx += orbitalVx
        p.vy += orbitalVy

        // Apply damping
        p.vx *= DAMPING
        p.vy *= DAMPING

        // Update position
        p.x += p.vx
        p.y += p.vy

        // Gentle pull back to orbit
        const targetX = centerX + Math.cos(p.targetAngle) * p.originalDistance
        const targetY = centerY + Math.sin(p.targetAngle) * p.originalDistance
        const restoreForce = 0.01
        p.vx += (targetX - p.x) * restoreForce
        p.vy += (targetY - p.y) * restoreForce
      })
    }

    const draw = (time: number) => {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Draw central star with glow
      const starSize = 30 + Math.sin(time * 0.003) * 5
      const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, starSize * 2)
      gradient.addColorStop(0, '#FFFFFF')
      gradient.addColorStop(0.3, '#FFD700')
      gradient.addColorStop(0.6, '#FFA500')
      gradient.addColorStop(1, 'rgba(255, 165, 0, 0)')
      
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(centerX, centerY, starSize * 2, 0, Math.PI * 2)
      ctx.fill()

      // Draw bright star core
      ctx.fillStyle = '#FFFFFF'
      ctx.beginPath()
      ctx.arc(centerX, centerY, starSize * 0.5, 0, Math.PI * 2)
      ctx.fill()

      // Draw particles with glow
      particles.forEach((p) => {
        // Glow effect
        const glowGradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2)
        glowGradient.addColorStop(0, p.color)
        glowGradient.addColorStop(0.5, p.color + '80')
        glowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
        
        ctx.fillStyle = glowGradient
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size * 2, 0, Math.PI * 2)
        ctx.fill()

        // Solid particle
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        ctx.fill()
      })
    }

    const animate = (time: number) => {
      updateParticles(time)
      draw(time)
      animationId = requestAnimationFrame(animate)
    }

    const handleResize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      initParticles()
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    
    // Start animation after a brief delay
    setTimeout(() => {
      animationId = requestAnimationFrame(animate)
    }, 100)

    return () => {
      window.removeEventListener('resize', handleResize)
      cancelAnimationFrame(animationId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: '#000000',
      }}
    />
  )
}
