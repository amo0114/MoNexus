/**
 * MoNexus Coin — decorative brand element.
 *
 * Use ONLY at decorative scales (≥ 96px). At smaller sizes the
 * "MONEXUS COIN" inscription, the 2026 mint mark, and the bevelled M
 * silhouette collapse into a gold blob. For inline icon usage (price
 * tags, points balance pills, list rows) keep using lucide-react's
 * `Coins` component.
 *
 * Canonical source for the same artwork: design-system/monexus/assets/coin.svg.
 * Update both when iterating on the mark.
 */

interface CoinIconProps {
  className?: string
}

export default function CoinIcon({ className = '' }: CoinIconProps) {
  return (
    <svg
      viewBox="0 0 800 800"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="coinBaseMetal" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFEDB0" />
          <stop offset="30%" stopColor="#DFB957" />
          <stop offset="50%" stopColor="#B28C34" />
          <stop offset="70%" stopColor="#EAD186" />
          <stop offset="90%" stopColor="#8E6A21" />
          <stop offset="100%" stopColor="#4C350A" />
        </radialGradient>

        <linearGradient id="coinEdgeGlow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.9" />
          <stop offset="30%" stopColor="#FFDC73" stopOpacity="0.3" />
          <stop offset="70%" stopColor="#AA7B25" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#FFEBA3" stopOpacity="0.8" />
        </linearGradient>

        <linearGradient id="coinShinyGold" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#FFF5CC" />
          <stop offset="40%" stopColor="#E8C359" />
          <stop offset="60%" stopColor="#BD9026" />
          <stop offset="100%" stopColor="#FFDD7A" />
        </linearGradient>

        <linearGradient id="coinDeepShadow" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#3A2807" />
          <stop offset="100%" stopColor="#7B5B16" />
        </linearGradient>

        <filter id="coinHeavyEmboss" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="3" dy="5" stdDeviation="4" floodColor="#1A1100" floodOpacity="0.75" />
          <feDropShadow dx="-1.5" dy="-1.5" stdDeviation="1" floodColor="#FFF0BA" floodOpacity="0.5" />
        </filter>

        <filter id="coinGlow">
          <feGaussianBlur stdDeviation="1.5" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <path id="coinTextTop" d="M 110, 400 A 290, 290 0 0, 1 690, 400" />
        <path id="coinTextBot" d="M 690, 400 A 290, 290 0 0, 1 110, 400" />
      </defs>

      <g>
        <circle cx="400" cy="405" r="380" fill="#000" opacity="0.6" filter="blur(8px)" />
        <circle cx="400" cy="400" r="380" fill="url(#coinBaseMetal)" />
        <circle cx="400" cy="400" r="378" fill="none" stroke="url(#coinEdgeGlow)" strokeWidth="4" filter="url(#coinGlow)" />

        <circle cx="400" cy="400" r="360" fill="none" stroke="url(#coinDeepShadow)" strokeWidth="32" strokeDasharray="8 12" />
        <circle cx="400" cy="400" r="360" fill="none" stroke="url(#coinShinyGold)" strokeWidth="32" strokeDasharray="8 12" transform="rotate(0.5 400 400)" />

        <circle cx="400" cy="400" r="340" fill="none" stroke="#2B1D04" strokeWidth="12" opacity="0.85" />
        <circle cx="400" cy="400" r="338" fill="none" stroke="url(#coinEdgeGlow)" strokeWidth="2" opacity="0.6" />

        <g opacity="0.12">
          <circle cx="400" cy="400" r="230" fill="none" stroke="#000" strokeWidth="1.5" strokeDasharray="1 3" />
          <circle cx="400" cy="400" r="220" fill="none" stroke="#000" strokeWidth="1" strokeDasharray="4 6" />
          <circle cx="400" cy="400" r="210" fill="none" stroke="#000" strokeWidth="0.5" strokeDasharray="1 1" />
          <circle cx="400" cy="400" r="100" fill="none" stroke="#000" strokeWidth="240" strokeDasharray="0.5 3" />
        </g>
        <g opacity="0.2">
          <circle cx="400" cy="400" r="100" fill="none" stroke="#FFF" strokeWidth="240" strokeDasharray="0.5 3" transform="rotate(0.2 400 400)" />
        </g>

        <circle cx="400" cy="400" r="245" fill="none" stroke="url(#coinShinyGold)" strokeWidth="8" filter="url(#coinHeavyEmboss)" />
        <circle cx="400" cy="400" r="255" fill="none" stroke="url(#coinDeepShadow)" strokeWidth="3" opacity="0.6" />

        <text fill="url(#coinShinyGold)" fontSize="68" fontFamily="'Trajan Pro', 'Cinzel', 'Times New Roman', serif" fontWeight="900" letterSpacing="12" filter="url(#coinHeavyEmboss)">
          <textPath href="#coinTextTop" startOffset="50%" textAnchor="middle">MONEXUS COIN</textPath>
        </text>

        <text fill="url(#coinShinyGold)" fontSize="42" fontFamily="'Trajan Pro', 'Cinzel', 'Times New Roman', serif" fontWeight="600" letterSpacing="18" opacity="0.9" filter="url(#coinHeavyEmboss)">
          <textPath href="#coinTextBot" startOffset="50%" textAnchor="middle">DIGITAL RESERVE</textPath>
        </text>

        <g fill="url(#coinShinyGold)" filter="url(#coinHeavyEmboss)">
          <path d="M 100, 400 L 115, 385 L 130, 400 L 115, 415 Z" />
          <path d="M 670, 400 L 685, 385 L 700, 400 L 685, 415 Z" />
          <line x1="115" y1="385" x2="115" y2="415" stroke="#FFF" strokeWidth="1.5" opacity="0.5" />
          <line x1="100" y1="400" x2="130" y2="400" stroke="#FFF" strokeWidth="1.5" opacity="0.5" />
          <line x1="685" y1="385" x2="685" y2="415" stroke="#FFF" strokeWidth="1.5" opacity="0.5" />
          <line x1="670" y1="400" x2="700" y2="400" stroke="#FFF" strokeWidth="1.5" opacity="0.5" />
        </g>

        <g stroke="url(#coinShinyGold)" strokeWidth="10" strokeLinecap="round" filter="url(#coinHeavyEmboss)" opacity="0.8">
          <line x1="340" y1="210" x2="340" y2="280" />
          <circle cx="340" cy="210" r="5" fill="url(#coinShinyGold)" stroke="none" />
          <line x1="340" y1="460" x2="340" y2="590" />
          <circle cx="340" cy="590" r="5" fill="url(#coinShinyGold)" stroke="none" />

          <line x1="460" y1="210" x2="460" y2="280" />
          <circle cx="460" cy="210" r="5" fill="url(#coinShinyGold)" stroke="none" />
          <line x1="460" y1="460" x2="460" y2="590" />
          <circle cx="460" cy="590" r="5" fill="url(#coinShinyGold)" stroke="none" />
        </g>

        <g filter="url(#coinHeavyEmboss)">
          <path
            d="M 220 530 L 250 220 L 300 220 L 400 380 L 500 220 L 550 220 L 580 530 L 515 530 L 495 310 L 400 460 L 305 310 L 285 530 Z"
            fill="url(#coinDeepShadow)"
            transform="translate(0, 6)"
          />
          <path
            d="M 220 530 L 250 220 L 300 220 L 400 380 L 500 220 L 550 220 L 580 530 L 515 530 L 495 310 L 400 460 L 305 310 L 285 530 Z"
            fill="url(#coinShinyGold)"
          />
          <path d="M 300 220 L 400 380 L 305 310 Z" fill="#FFF5CC" opacity="0.4" />
          <path d="M 550 220 L 580 530 L 515 530 L 495 310 Z" fill="#FFF5CC" opacity="0.3" />
          <path d="M 220 530 L 250 220 L 300 220 L 285 530 Z" fill="#7B5B16" opacity="0.4" />
          <path d="M 400 380 L 500 220 L 495 310 Z" fill="#7B5B16" opacity="0.5" />
          <path d="M 300 220 L 400 380 L 500 220" fill="none" stroke="#FFFFFF" strokeWidth="4" strokeLinejoin="round" opacity="0.5" />
          <path d="M 400 460 L 400 380" fill="none" stroke="#7B5B16" strokeWidth="4" opacity="0.7" />
        </g>

        <g filter="url(#coinHeavyEmboss)">
          <rect x="360" y="635" width="80" height="26" rx="4" fill="url(#coinDeepShadow)" opacity="0.8" />
          <rect x="361" y="636" width="78" height="24" rx="3" fill="none" stroke="url(#coinShinyGold)" strokeWidth="1" opacity="0.6" />
          <text x="400" y="654" fill="url(#coinShinyGold)" fontSize="16" fontFamily="'Trajan Pro', 'Cinzel', 'Arial', sans-serif" fontWeight="bold" textAnchor="middle" letterSpacing="4">
            2026
          </text>
        </g>
      </g>
    </svg>
  )
}
