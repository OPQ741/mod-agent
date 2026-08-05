import DefaultTheme from "vitepress/theme"
import type { Theme } from "vitepress"
import "./mermaid-zoom.css"

function setupMermaidZoom() {
  if (typeof window === "undefined") return
  if ((window as Window & { __mermaidZoomBound?: boolean }).__mermaidZoomBound) {
    return
  }
  ;(window as Window & { __mermaidZoomBound?: boolean }).__mermaidZoomBound = true

  const overlay = document.createElement("div")
  overlay.className = "mermaid-zoom-overlay"
  overlay.setAttribute("hidden", "")
  overlay.setAttribute("role", "presentation")
  overlay.innerHTML = `
    <button type="button" class="mermaid-zoom-close" aria-label="关闭放大图">×</button>
    <div class="mermaid-zoom-dialog" role="dialog" aria-modal="true" aria-label="放大查看流程图"></div>
  `
  document.body.appendChild(overlay)

  const dialog = overlay.querySelector(".mermaid-zoom-dialog") as HTMLElement
  const closeBtn = overlay.querySelector(".mermaid-zoom-close") as HTMLElement

  const close = () => {
    overlay.setAttribute("hidden", "")
    dialog.innerHTML = ""
    document.body.style.removeProperty("overflow")
  }

  const open = (svg: SVGElement) => {
    const clone = svg.cloneNode(true) as SVGElement
    const viewBox = clone
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number)
    if (viewBox && viewBox.length >= 4) {
      clone.setAttribute("width", String(viewBox[2]))
      clone.setAttribute("height", String(viewBox[3]))
    }
    clone.removeAttribute("style")
    dialog.replaceChildren(clone)
    overlay.removeAttribute("hidden")
    document.body.style.overflow = "hidden"
    closeBtn.focus()
  }

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close()
  })
  closeBtn.addEventListener("click", close)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hasAttribute("hidden")) close()
  })

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null
    if (!target || overlay.contains(target)) return
    const container = target.closest(".mermaid")
    if (!container) return
    const svg = container.querySelector("svg")
    if (!svg) return
    event.preventDefault()
    open(svg)
  })
}

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof window === "undefined") return
    setupMermaidZoom()
  },
} satisfies Theme
