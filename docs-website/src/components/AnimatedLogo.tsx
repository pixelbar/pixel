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
  spiralArm: number
}

export function AnimatedLogo() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    let animationId: number
    let particles: Particle[] = []
    
    const centerX = canvas.width / 2
    const centerY = canvas.height / 2

    // Rainbow colors matching the logo - following the spiral progression
    const rainbowColors = [
      '#00FFFF', // Cyan
      '#0080FF', // Blue
      '#4040FF', // Royal blue
      '#8040FF', // Purple
      '#C040FF', // Violet
      '#FF40FF', // Magenta
      '#FF40A0', // Pink
      '#FF4060', // Hot pink
      '#FF4040', // Red
      '#FF8040', // Orange
      '#FFFF40', // Yellow
      '#80FF40', // Lime
      '#40FF40', // Green
      '#40FF80', // Sea green
      '#40FFFF', // Cyan (loop back)
    ]

    // Initialize particles in a double spiral pattern
    const initParticles = () => {
      particles = []
      const spiralArms = 2
      const particlesPerArm = 60
      const scatteredParticles = 40
      
      // Create main spiral arms
      for (let arm = 0; arm < spiralArms; arm++) {
        for (let i = 0; i < particlesPerArm; i++) {
          const t = i / particlesPerArm
          const angle = (arm * Math.PI) + (t * Math.PI * 4)
          const distance = 30 + t * 300
          
          // Color index based on position along spiral
          const colorProgress = (angle / (Math.PI * 4)) % 1
          const colorIndex = Math.floor(colorProgress * rainbowColors.length) % rainbowColors.length
          
          // Varying sizes for pixelated effect
          const size = t < 0.2 ? 6 + Math.random() * 4 : 4 + Math.random() * 8
          
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
            color: rainbowColors[colorIndex],
            size,
            spiralArm: arm,
          })
        }
      }
      
      // Add scattered particles around the edges
      for (let i = 0; i < scatteredParticles; i++) {
        const angle = Math.random() * Math.PI * 2
        const distance = 200 + Math.random() * 150
        const colorIndex = Math.floor(Math.random() * rainbowColors.length)
        
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
          color: rainbowColors[colorIndex],
          size: 4 + Math.random() * 6,
          spiralArm: -1,
        })
      }
    }

    // Physics simulation with gravity toward center
    const updateParticles = (time: number) => {
      const GRAVITY = 0.25
      const ROTATION_SPEED = 0.0008
      const DAMPING = 0.94
      const ORBIT_STRENGTH = 0.04
      const WOBBLE = 0.02

      particles.forEach((p) => {
        // Calculate vector to center
        const dx = centerX - p.x
        const dy = centerY - p.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        
        // Gravity pull toward center
        if (dist > 25) {
          const force = GRAVITY * (dist / 100)
          p.vx += (dx / dist) * force
          p.vy += (dy / dist) * force
        }

        // Orbital motion for spiral arms
        if (p.spiralArm >= 0) {
          const currentAngle = Math.atan2(p.y - centerY, p.x - centerX)
          p.targetAngle = p.originalAngle + time * ROTATION_SPEED
          
          // Tangential velocity
          const orbitalVx = -Math.sin(currentAngle) * ORBIT_STRENGTH * p.originalDistance / 100
          const orbitalVy = Math.cos(currentAngle) * ORBIT_STRENGTH * p.originalDistance / 100
          
          p.vx += orbitalVx
          p.vy += orbitalVy

          // Add wobble
          p.vx += (Math.sin(time * 0.001 + p.originalAngle) * WOBBLE)
          p.vy += (Math.cos(time * 0.001 + p.originalAngle) * WOBBLE)
        } else {
          // Scattered particles have gentle drift
          p.vx += (Math.sin(time * 0.0005 + p.angle) * 0.005)
          p.vy += (Math.cos(time * 0.0005 + p.angle) * 0.005)
        }

        // Apply damping
        p.vx *= DAMPING
        p.vy *= DAMPING

        // Update position
        p.x += p.vx
        p.y += p.vy

        // Gentle pull back to orbit for spiral arms
        if (p.spiralArm >= 0) {
          const targetX = centerX + Math.cos(p.targetAngle) * p.originalDistance
          const targetY = centerY + Math.sin(p.targetAngle) * p.originalDistance
          const restoreForce = 0.008
          p.vx += (targetX - p.x) * restoreForce
          p.vy += (targetY - p.y) * restoreForce
        }
      })
    }

    const draw = (time: number) => {
      // Clear with pure black
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Draw central star burst with cross shape
      const starSize = 25 + Math.sin(time * 0.002) * 3
      
      // Outer glow
      const outerGlow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, starSize * 3)
      outerGlow.addColorStop(0, 'rgba(255, 255, 255, 0.8)')
      outerGlow.addColorStop(0.2, 'rgba(255, 255, 200, 0.4)')
      outerGlow.addColorStop(0.5, 'rgba(255, 200, 100, 0.2)')
      outerGlow.addColorStop(1, 'rgba(255, 100, 0, 0)')
      
      ctx.fillStyle = outerGlow
      ctx.fillRect(centerX - starSize * 3, centerY - starSize * 3, starSize * 6, starSize * 6)

      // Star cross/burst
      ctx.fillStyle = '#FFFFFF'
      // Vertical beam
      ctx.fillRect(centerX - 3, centerY - starSize * 2, 6, starSize * 4)
      // Horizontal beam
      ctx.fillRect(centerX - starSize * 2, centerY - 3, starSize * 4, 6)
      
      // Bright core
      const coreGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, starSize)
      coreGradient.addColorStop(0, '#FFFFFF')
      coreGradient.addColorStop(0.5, '#FFFFCC')
      coreGradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
      
      ctx.fillStyle = coreGradient
      ctx.beginPath()
      ctx.arc(centerX, centerY, starSize, 0, Math.PI * 2)
      ctx.fill()

      // Draw particles as pixelated squares with glow
      particles.forEach((p) => {
        // Strong outer glow
        const glowSize = p.size * 3
        const glowGradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowSize)
        glowGradient.addColorStop(0, p.color + 'CC')
        glowGradient.addColorStop(0.3, p.color + '80')
        glowGradient.addColorStop(0.6, p.color + '30')
        glowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
        
        ctx.fillStyle = glowGradient
        ctx.fillRect(p.x - glowSize, p.y - glowSize, glowSize * 2, glowSize * 2)

        // Medium glow
        const midGlowSize = p.size * 1.5
        const midGlow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, midGlowSize)
        midGlow.addColorStop(0, p.color + 'FF')
        midGlow.addColorStop(0.5, p.color + 'CC')
        midGlow.addColorStop(1, p.color + '40')
        
        ctx.fillStyle = midGlow
        ctx.fillRect(p.x - midGlowSize, p.y - midGlowSize, midGlowSize * 2, midGlowSize * 2)

        // Solid pixelated square (no rounded corners)
        ctx.fillStyle = p.color
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
        
        // Bright highlight on pixel
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size * 0.4, p.size * 0.4)
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
    
    // Start animation
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
