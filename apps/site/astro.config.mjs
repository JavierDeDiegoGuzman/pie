// The Pie website: a landing page and the docs, which live in packages/sdk/docs
// (scripts/sync-docs.mjs copies them in before dev and build).
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://javierdediegoguzman.github.io",
  base: "/pie",
  integrations: [
    starlight({
      title: "Pie",
      description: "pi, reimplemented on Effect: a durable, self-modifying coding agent.",
      logo: { src: "./src/assets/pie.svg" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/JavierDeDiegoGuzman/pie" }],
      editLink: { baseUrl: "https://github.com/JavierDeDiegoGuzman/pie/edit/main/packages/sdk/docs/" },
      customCss: [
        "@fontsource-variable/inter",
        "@fontsource-variable/fraunces",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/theme.css"
      ],
      sidebar: [
        { label: "Start here", items: ["getting-started", "why"] },
        { label: "Docs", items: ["docs/plugins", "docs/events", "docs/core", "docs/architecture"] },
        { label: "Project", items: ["docs/references", "changelog"] }
      ]
    })
  ]
})
