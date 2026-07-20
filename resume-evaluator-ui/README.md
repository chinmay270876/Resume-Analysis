# 🚀 AI Resume Intelligence Platform (UI)

A premium, interactive web-based dashboard built using **Angular 22** designed to transform plain PDF resumes into deep, actionable insights. By interfacing with an AI backend, this platform enables automated candidate evaluation, interview transcript generation, and even plays generated AI podcast reports.

---

## 🌟 Key Features

* **📄 Resume Analysis**: Automatically extracts candidate names, experience levels, and primary skills from uploaded PDFs.
* **📊 Candidate Scoring**: Computes a detailed overall evaluation score (out of 100) alongside explicit matching recommendations (e.g. *Highly Recommended*, *Recommended*).
* **🎤 Interview Transcript Generator**: Automatically formats and displays a realistic AI-generated interview transcript matching the candidate's profile.
* **🎧 Podcast Streamer**: Directly streams an AI-synthesized audio podcast summary of the candidate's interview and credentials.
* **📥 Seamless Reports**: Fully interactive download triggers for detailed Excel reports (`.xlsx`) and transcript documents (`.txt`).
* **✨ Glassmorphic UI**: Styled with a dark-theme, responsive design featuring glassmorphism cards, glowing status backdrops, and modern micro-animations.

---

## 🛠️ Tech Stack

* **Framework**: [Angular v22](https://angular.dev/) (Standalone Components, SSR enabled)
* **Styling**: Vanilla CSS with custom CSS Grid systems, glassmorphism variables, and responsive layouts
* **Data Visualization**: Integrated with `Chart.js` & `ng2-charts` (ready for future analytics expansion)
* **Unit Testing**: Powered by [Vitest](https://vitest.dev/) for quick and reliable component verification
* **Formatting**: [Prettier](https://prettier.io/) for unified code formatting styles

---

## 🚀 Getting Started

### Prerequisites

Make sure you have Node.js (version 20+ recommended) and npm installed.

### Setup Instructions

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Run Backend Service**:
   Ensure your backend API server is running on `http://localhost:3000`. 
   *(In typical setups, you run this in the sister directory `/resume-evaluator` with `node server.js`).*

3. **Start Development Server**:
   ```bash
   npm start
   ```
   Open your browser and navigate to `http://localhost:4200/`.

4. **Verify / Run Unit Tests**:
   ```bash
   npm test
   ```

5. **Production Build**:
   ```bash
   npm run build
   ```

---

## 📂 Project Structure

```
resume-evaluator-ui/
├── src/
│   ├── app/
│   │   ├── components/       # Reusable components
│   │   ├── pages/            # Page routing endpoints
│   │   │   └── upload/       # Main resume upload & analysis dashboard page
│   │   ├── services/         # API Integration services (e.g., ResumeService)
│   │   ├── app.ts            # Main application bootstrap component
│   │   └── app.routes.ts     # Frontend path routing declarations
│   ├── index.html            # Main HTML document template
│   ├── styles.css            # Global CSS overrides & layout reset variables
│   └── main.ts               # App entrypoint
├── angular.json              # Angular workspace configuration
├── package.json              # Dependency & scripts manifest
└── tsconfig.json             # TypeScript compile rules
```
