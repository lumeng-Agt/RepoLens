# Third-party notices

RepoLens’s Windows desktop package includes Electron and the runtime libraries below. Its compiled renderer also incorporates the listed UI/runtime libraries. License identifiers follow the package metadata in `package-lock.json`.

| Component | Version | License | Use |
|---|---:|---|---|
| Electron | 44.5.1 | MIT | Windows desktop runtime; Electron distribution also carries Chromium, V8 and Node notices |
| TypeScript | 5.9.3 | Apache-2.0 | JavaScript/TypeScript static analysis |
| Zod | 3.25.76 | MIT | Local API and AI response validation |
| ignore | 5.3.2 | MIT | `.gitignore` and `.repolensignore` handling |
| web-tree-sitter | 0.20.8 | MIT | Python and Go WASM parser runtime |
| Tree-sitter WASM collection | 0.1.13 | Unlicense | Source of the bundled Python and Go grammar WASM files; license text is [included here](./data/tree-sitter-wasms-LICENSE) |
| React / React DOM | 19.2.6 | MIT | User interface |
| @xyflow/react | 12.12.0 | MIT | Dependency graph |
| @dagrejs/dagre | 3.1.1 | MIT | Graph layout |
| PrismJS | 1.30.0 | MIT | Source highlighting |
| Lucide React | 1.31.0 | ISC | Interface icons |
| Base UI, Radix UI, shadcn, cmdk, Vaul | package-lock versions | MIT | Interface controls |
| Recharts, React Hook Form, resolvers, date-fns, Embla, React Day Picker, React Resizable Panels, Sonner, class-variance-authority, clsx, tailwind-merge, input-otp, next-themes | package-lock versions | See each package metadata; direct package licenses are MIT except class-variance-authority (Apache-2.0) and Lucide React (ISC) | Bundled interface utilities |

The Electron runtime’s packaged `LICENSE`, `LICENSES.chromium.html`, and other upstream notices are distributed with the application. The package lock records exact versions and dependency metadata for transitive components. Build-only tools, test runners, and bundlers are not included in the desktop application package.
