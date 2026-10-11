# Pixel Documentation Website

Beautiful, modern documentation website for Pixel - the Discord bot assistant for the Pixelbar hackerspace.

## ✨ Features

- **Vibrant Design**: Pixelated rainbow theme with blues, purples, pinks, oranges, yellows, and greens on black
- **Fully Responsive**: Optimized for desktop, tablet, and mobile devices
- **Modern Tech Stack**: Built with Vite, React, and TypeScript
- **Fast & Lightweight**: Optimized build with code splitting
- **Accessible**: WCAG-compliant with proper semantic HTML

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

The development server will start at `http://localhost:3000`.

## 📁 Project Structure

```
docs-website/
├── public/           # Static assets
│   └── favicon.svg   # Pixelated rainbow favicon
├── src/
│   ├── components/   # Reusable components
│   │   ├── Navigation.tsx
│   │   ├── Navigation.module.css
│   │   ├── Footer.tsx
│   │   └── Footer.module.css
│   ├── pages/        # Page components
│   │   ├── Home.tsx
│   │   ├── Home.module.css
│   │   ├── Installation.tsx
│   │   ├── Setup.tsx
│   │   ├── Usage.tsx
│   │   ├── Interact.tsx
│   │   └── Documentation.module.css
│   ├── styles/       # Global styles & theme
│   │   ├── global.css
│   │   └── theme.ts
│   ├── App.tsx       # Main app component
│   └── main.tsx      # Entry point
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## 🎨 Design System

### Colors

The design uses a vibrant pixelated rainbow theme:

- **Blue**: `#0080ff` - Primary actions, links
- **Purple**: `#a855f7` - Secondary accents, highlights
- **Pink**: `#ec4899` - Attention, warnings
- **Orange**: `#f97316` - Energy, calls-to-action
- **Yellow**: `#fbbf24` - Warmth, success states
- **Green**: `#10b981` - Success, code blocks
- **Black**: `#000000` - Background
- **Grays**: Various shades for text and UI elements

### Typography

- **Headings**: Inter (weights: 700-900)
- **Body**: Inter (weights: 400-600)
- **Code**: JetBrains Mono

### Components

- Responsive navigation with mobile menu
- Feature cards with hover effects
- Command documentation with tier badges
- Code blocks with syntax highlighting
- Glowing buttons and accents
- Accessibility-focused design

## 🌐 Pages

1. **Home** (`/`) - Hero, features, tech stack, quick start
2. **Installation** (`/installation`) - Prerequisites, setup steps, troubleshooting
3. **Setup** (`/setup`) - Configuration, environment variables, access control
4. **Usage** (`/usage`) - Command reference, scheduled posts, Home Assistant
5. **Interact** (`/interact`) - Best practices, access levels, privacy

## 🚢 Deployment

### Build

```bash
pnpm build
```

The production build will be in the `dist/` directory.

### Serve

You can serve the production build with any static file server:

```bash
# Using Vite's preview server
pnpm preview

# Using a simple HTTP server
npx serve dist

# Using nginx, Apache, or any other web server
# Point the document root to the dist/ directory
```

### Deploy to Common Platforms

#### Vercel
```bash
vercel --prod
```

#### Netlify
```bash
netlify deploy --prod --dir=dist
```

#### GitHub Pages
```bash
# Build the site
pnpm build

# Push dist/ to gh-pages branch
# (or use gh-pages package)
```

#### Azure Static Web Apps
```bash
# Configure azure-static-web-apps.yml
# Push to repository
```

## 🔧 Development

### Hot Reload

The dev server supports hot module replacement (HMR) - changes appear instantly without full page reload.

### TypeScript

The project uses strict TypeScript for type safety. Run type checking with:

```bash
pnpm exec tsc --noEmit
```

### Code Style

CSS Modules are used for component styling to avoid naming conflicts and enable local scoping.

## 📝 Content Updates

To update documentation content:

1. Edit the relevant page component in `src/pages/`
2. Changes will hot-reload in development
3. Commit and push changes
4. Rebuild and redeploy

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

Same license as the Pixel bot (TBD).

## 🙏 Credits

Built for the Pixelbar hackerspace community. Design inspired by Pixel's vibrant, pixelated aesthetic.
