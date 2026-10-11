import styled from './Footer.module.css'

export function Footer() {
  return (
    <footer className={styled.footer}>
      <div className={styled.container}>
        <div className={styled.content}>
          <div className={styled.section}>
            <h3 className={styled.heading}>Pixel</h3>
            <p className={styled.description}>
              A helpful assistant bot for the Pixelbar hackerspace in Rotterdam.
            </p>
          </div>

          <div className={styled.section}>
            <h3 className={styled.heading}>Links</h3>
            <ul className={styled.linkList}>
              <li>
                <a
                  href="https://pixelbar.nl"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styled.link}
                >
                  Pixelbar Website
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/pixelbar/pixel"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styled.link}
                >
                  GitHub Repository
                </a>
              </li>
              <li>
                <a
                  href="https://spaceapi.pixelbar.nl"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styled.link}
                >
                  Space API
                </a>
              </li>
            </ul>
          </div>

          <div className={styled.section}>
            <h3 className={styled.heading}>Community</h3>
            <ul className={styled.linkList}>
              <li>
                <span className={styled.link}>Discord Server</span>
              </li>
              <li>
                <span className={styled.link}>Mastodon</span>
              </li>
            </ul>
          </div>
        </div>

        <div className={styled.bottom}>
          <p className={styled.copyright}>
            © {new Date().getFullYear()} Pixelbar. Built with ❤️ by the community.
          </p>
          <div className={styled.badges}>
            <span className={styled.badge}>TypeScript</span>
            <span className={styled.badge}>Discord.js</span>
            <span className={styled.badge}>Node.js</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
