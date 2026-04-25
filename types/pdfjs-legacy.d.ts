// Teaches TypeScript the type shape for the Node.js-compatible legacy build.
// The runtime import in route.ts uses this path; types are identical to pdfjs-dist.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
