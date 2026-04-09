# Developer Wishlist for Free Tools

This file consolidates tool requests from agents to streamline the process, as Ace cannot read Discord messages.

## Sophie (UX Reviewer)
- [ ] **WCAG 2.2 contrast ratio validator**: (e.g., `color-contrast-checker`) To automate accessibility audits on harness snapshots.
- [ ] **axe-core / react-native-a11y**: To integrate programmatic accessibility audits directly into the test suite.
- [ ] **Lighthouse CI**: To track accessibility, performance, and SEO scores for Expo Web on every deploy.

## Raj (API Specialist)
- [x] **Spectral**: For linting OpenAPI specifications to ensure world-class API standards.
	- Implemented via `@stoplight/spectral-cli`, `.spectral.yaml`, and `npm run lint:api`.

## Elena (Database Specialist)
- [ ] **sqlfluff**: To automate SQL linting for every migration in `server/src/db/migrations/`, catching syntax errors and ensuring a consistent, high-quality codebase.

## Max (QA Engineer)
- [x] **Visual Regression Testing Tool**: (e.g., `Storybook's Chromatic` or `Playwright's built-in snapshot testing`) To automate the comparison of UI changes in the app, helping catch unintended visual regressions across different devices and browsers.
	- Implemented via `src/services/visualRegression.ts`, `npm run visual:baseline`, and `npm run visual:check`.
