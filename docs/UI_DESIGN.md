# UI Design — Apify Collector

**Version:** 1.0.0
**Date:** 2026-06-21

---

## 1. Design Principles

- **Dark theme:** Easy on eyes, modern look
- **Minimal:** No unnecessary visual elements
- **Functional:** Every element serves a purpose
- **Responsive:** Works on desktop (>= 1024px)

## 2. Color Palette

### Background
| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#0f0f13` | Main background |
| `--bg-secondary` | `#13131a` | Panel background |
| `--bg-card` | `#16161d` | Card, header |
| `--bg-input` | `#1a1a24` | Input fields, badges |

### Text
| Token | Value | Usage |
|-------|-------|-------|
| `--text-primary` | `#ffffff` | Headings, important text |
| `--text-secondary` | `#e0e0e0` | Body text |
| `--text-muted` | `#888888` | Labels, hints |

### Accent
| Token | Value | Usage |
|-------|-------|-------|
| `--accent` | `#6c5ce7` | Primary buttons, focus |
| `--accent-hover` | `#a855f7` | Button hover |

### Status
| Token | Value | Usage |
|-------|-------|-------|
| `--success` | `#27ae60` | Done status |
| `--warning` | `#f39c12` | Running status |
| `--danger` | `#e74c3c` | Failed status, delete |

### Border
| Token | Value | Usage |
|-------|-------|-------|
| `--border` | `#2a2a35` | All borders |

## 3. Platform Colors

| Platform | Color | CSS Class |
|----------|-------|-----------|
| Facebook | `#4599ff` | `.job-platform.facebook` |
| TikTok | `#ff4d8a` | `.job-platform.tiktok` |
| Pinterest | `#ff6b6b` | `.job-platform.pinterest` |
| Etsy | `#f1641e` | `.job-platform.etsy` |
| Amazon | `#ff9900` | `.job-platform.amazon` |
| Reddit | `#ff6b3d` | `.job-platform.reddit` |
| Google | `#6ba3f7` | `.job-platform.google` |
| Shopify | `#96bf48` | `.job-platform.shopify` |

## 4. Layout

### 4.1 Header
```
┌──────────────────────────────────────────────────────────────┐
│  📊 Apify Collector    12 jobs    345 items                  │
└──────────────────────────────────────────────────────────────┘
```
- Fixed at top
- Height: ~57px
- Background: `--bg-card`
- Border-bottom: 1px solid `--border`

### 4.2 Main Layout (Two Panels)
```
┌────────────────────┬─────────────────────────────────────────┐
│                    │                                         │
│   New Job Panel    │           Jobs Panel                    │
│   (380px fixed)    │           (flex: 1)                     │
│                    │                                         │
│  - Platform select │  - Panel header with Refresh button     │
│  - Query input     │  - Jobs list (scrollable)               │
│  - Max items       │                                         │
│  - Country         │  ┌─────────────────────────────────┐   │
│  - Start button    │  │ Job cards...                     │   │
│  - Status bar      │  │                                  │   │
│                    │  └─────────────────────────────────┘   │
│                    │                                         │
└────────────────────┴─────────────────────────────────────────┘
```
- Grid: `grid-template-columns: 380px 1fr`
- Height: `calc(100vh - 57px)`
- Both panels scroll independently

### 4.3 Job Card
```
┌─────────────────────────────────────────────────────────────┐
│  [FB]  keyword search for shoes         ✅ done   45 items │
│        6/21/2026, 10:30 AM                                  │
└─────────────────────────────────────────────────────────────┘
```
- Flexbox row
- Platform badge (colored, uppercase)
- Query text (truncated with ellipsis)
- Status badge (colored)
- Items count
- Click → opens detail modal

### 4.4 Detail Modal
```
┌─────────────────────────────────────────────────────────────┐
│  📘 Facebook Posts — #12                          [×]       │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ Platform │ │  Query   │ │  Items   │ │  Status  │      │
│  │facebook  │ │  shoes   │ │   45     │ │  done    │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
│                                                             │
│  ┌─────────────────┐ ┌─────────────────┐ ┌───────────────┐ │
│  │ { raw data }    │ │ { raw data }    │ │ { raw data }  │ │
│  │                 │ │                 │ │               │ │
│  └─────────────────┘ └─────────────────┘ └───────────────┘ │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  [Export JSON]  [Delete]                                     │
└─────────────────────────────────────────────────────────────┘
```
- Overlay with blur background
- Max-width: 900px, max-height: 80vh
- Scrollable body
- Items grid: auto-fill, minmax(280px, 1fr)

## 5. Components

### 5.1 Buttons
- **Primary:** Gradient background (accent → accent-hover), full width
- **Small:** Outlined, used for Refresh, Export, Delete
- **Disabled:** 40% opacity, no cursor

### 5.2 Form Elements
- **Input/Select:** Dark background (`--bg-input`), border on focus
- **Label:** Uppercase, small, muted color
- **Hint:** Small text below input

### 5.3 Status Badges
- Pill shape (border-radius: 12px)
- Background: status color at 13% opacity
- Text: status color

### 5.4 Platform Badges
- Pill shape (border-radius: 6px)
- Background: platform color at 13% opacity
- Text: platform color

## 6. Typography

| Element | Size | Weight | Color |
|---------|------|--------|-------|
| Header h1 | 20px | 700 | `--text-primary` |
| Panel h2 | 16px | 600 | `--text-primary` |
| Job query | 14px | 400 | `--text-primary` |
| Job meta | 11px | 400 | `#666` |
| Status badge | 11px | 600 | status color |
| Form label | 12px | 500 | `--text-muted` |
| Form input | 14px | 400 | `--text-primary` |
| Button | 14px | 500 | `--text-primary` |
| Stat pill | 13px | 400 | `--text-secondary` |

## 7. Spacing

| Element | Value |
|---------|-------|
| Panel padding | 24px |
| Card padding | 12px-16px |
| Form group margin | 16px |
| Gap between cards | 8px |
| Button padding | 10px 20px |
| Modal padding | 24px |

## 8. Animations

- **Status dot pulse:** 1.5s infinite, opacity 1→0.3→1
- **Button hover:** translateY(-1px) + box-shadow
- **Card hover:** border-color change + background lighten
- **Transition:** 0.2s ease on all interactive elements

## 9. Responsive Breakpoint

At `max-width: 768px`:
- Switch to single column layout
- New job panel on top, jobs list below
- Info grid: 2 columns instead of 4
