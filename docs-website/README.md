# Pixel Landing Page

A striking landing page for Pixel - the Discord bot assistant for the Pixelbar hackerspace.

## ✨ Features

- **Animated Logo**: Canvas-based particle animation with gravity physics
- **Pixelated Rainbow Swirl**: Vibrant particles orbiting a central bright star
- **Physics Simulation**: Realistic gravity and orbital mechanics
- **Responsive Design**: Adapts to all screen sizes
- **Performant**: Smooth 60fps animation using requestAnimationFrame

## 🎨 Design

- **Background**: Pure black (#000000)
- **Central Star**: Bright white core with golden glow
- **Particle Colors**: Vibrant rainbow spectrum
  - Deep pink, hot pink
  - Medium orchid, medium purple
  - Royal blue, dodger blue
  - Dark turquoise, medium spring green
  - Green yellow, gold
  - Orange, tomato

## 🚀 Quick Start

### Prerequisites

- Node.js LTS (18+)
- pnpm (or npm/yarn)

### Installation

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview
```

The development server will start at `http://localhost:5173`.

## 📁 Project Structure

```
docs-website/
├── public/           # Static assets
├── src/
│   ├── components/   # React components
│   │   └── AnimatedLogo.tsx  # Canvas particle animation
│   ├── styles/       # Global styles
│   ├── App.tsx       # Main app component
│   └── main.tsx      # Entry point
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## 🔧 Animation Details

The animated logo uses:
- **HTML5 Canvas** for rendering
- **Particle System** with 320 particles in 8 spiral arms
- **Physics Engine**: Gravity toward center + orbital velocity
- **Color System**: 12-color rainbow gradient
- **Glow Effects**: Radial gradients for star and particles
- **Responsive**: Adapts to window resize

### Physics Parameters

- Gravity: 0.3 force toward center
- Rotation Speed: 0.001 radians per frame
- Damping: 0.92 (velocity decay)
- Orbit Strength: 0.05 tangential force
- Restore Force: 0.01 (keeps particles in orbit)

## 🚢 Deployment

### Build

```bash
pnpm build
```

The production build will be in the `dist/` directory.

### Serve

```bash
# Using Vite's preview server
pnpm preview

# Using any static file server
npx serve dist
```

### Deploy to Platforms

Works with any static hosting:
- Vercel
- Netlify
- GitHub Pages
- Azure Static Web Apps
- Cloudflare Pages

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

Same license as the Pixel bot.

## 🙏 Credits

Built for the Pixelbar hackerspace community.
