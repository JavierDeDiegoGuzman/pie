// The Pie website: a landing page and the docs, which live in packages/sdk/docs
// (scripts/sync-docs.mjs copies them in before dev and build).
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"

export default defineConfig({
  // MDX pages load satteri, a native module: keep it out of the prerender bundle so Node finds its binary.
  vite: { ssr: { external: ["satteri"] } },
  site: "https://javierdediegoguzman.github.io",
  base: "/pie",
  integrations: [
    starlight({
      title: "Pie",
      description: "pi, reimplemented on Effect: a durable, self-modifying coding agent.",
      logo: { src: "./src/assets/pie.svg" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/JavierDeDiegoGuzman/pie" }],
      components: { PageTitle: "./src/components/PageTitle.astro" },
      expressiveCode: {
        // Dark code in both themes, like the landing page.
        themes: ["vitesse-dark"],
        styleOverrides: {
          borderRadius: "0.9rem",
          borderColor: "#3a2a20",
          codeBackground: "#1a110c",
          codeFontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
          codeFontSize: "0.85rem",
          frames: {
            editorTabBarBackground: "#1f1510",
            editorActiveTabBackground: "#1a110c",
            editorActiveTabIndicatorTopColor: "#c42f4a",
            terminalTitlebarBackground: "#1f1510",
            terminalTitlebarDotsForeground: "#5b4333",
            terminalBackground: "#1a110c",
            frameBoxShadowCssValue: "none"
          }
        }
      },
      editLink: { baseUrl: "https://github.com/JavierDeDiegoGuzman/pie/edit/main/packages/sdk/docs/" },
      customCss: [
        "@fontsource-variable/inter",
        "@fontsource-variable/fraunces",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/theme.css"
      ],
      sidebar: [
        { label: "Start here", items: ["getting-started", "why"] },
        { label: "Docs", items: ["docs/sdk", "docs/plugins", "docs/events", "docs/core", "docs/architecture"] },
        { label: "Project", items: ["docs/references", "changelog"] }
      ]
    })
  ]
})
