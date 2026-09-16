// Local path entries resolve `<directory>/tui.<extension>`; this shim keeps that loader contract at the repository root while the implementation lives in `src/`.
export { default } from "./src/plugin.tsx"
