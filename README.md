# Resume Analysis & AI Interview Evaluation

An AI-powered Resume Analysis platform that automatically extracts information from resumes, evaluates candidates using Large Language Models (LLMs), conducts AI-generated interviews, scores candidates using ATS metrics, and generates downloadable evaluation reports.

---

## 🚀 Features

- 📄 PDF Resume Upload
- 🧠 AI-based Resume Parsing
- 👤 Candidate Information Extraction
- 💼 Skills & Experience Detection
- 🎯 ATS Compatibility Evaluation
- 🎤 AI Interview Generation
- 📊 Candidate Scoring
- 📑 Excel Report Generation
- 🌐 Angular Frontend + Node.js Backend
- ☁️ Render Deployment Ready

---

## Tech Stack

### Frontend
- Angular
- TypeScript
- HTML/CSS
- RxJS

### Backend
- Node.js
- Express.js
- Multer
- PDF Parser
- ExcelJS
- OpenAI API

### AI
- GPT-4o Mini (OpenAI)

### Deployment
- Render

---

## Project Structure

```
Resume-Analysis/
│
├── resume-evaluator/
│   ├── src/
│   │   ├── controllers/
│   │   ├── services/
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── utils/
│   │   └── templates/
│   │
│   ├── output/
│   ├── results/
│   ├── uploads/
│   ├── server.js
│   └── package.json
│
├── resume-evaluator-ui/
│   ├── src/
│   ├── angular.json
│   └── package.json
│
└── README.md
```

---

# Workflow

```
Resume Upload
      │
      ▼
PDF Text Extraction
      │
      ▼
Resume Analysis using OpenAI
      │
      ▼
Candidate Information Extraction
      │
      ▼
AI Interview Generation
      │
      ▼
ATS Evaluation
      │
      ▼
Excel Report Generation
      │
      ▼
Download Evaluation Report
```

---

# Installation

## Clone Repository

```bash
git clone https://github.com/<your-username>/Resume-Analysis.git

cd Resume-Analysis
```

---

## Backend Setup

```bash
cd resume-evaluator

npm install
```

Create a `.env`

```env
NODE_ENV=development

PORT=3000

OPENAI_API_KEY=YOUR_OPENAI_API_KEY

MODEL_NAME=gpt-4o-mini

CORS_ORIGINS=http://localhost:4200
```

Run backend

```bash
npm start
```

Backend

```
http://localhost:3000
```

---

## Frontend Setup

```bash
cd resume-evaluator-ui

npm install

ng serve
```

Frontend

```
http://localhost:4200
```

---

# API Endpoints

## Health Check

```
GET /
```

Response

```json
{
  "success": true,
  "message": "Resume Evaluator API Running"
}
```

---

## Upload Resume

```
POST /api/upload-resume
```

Form Data

```
resume : PDF File
```

Response

```json
{
    "success": true,
    "candidate": {
        ...
    }
}
```

---

# Generated Outputs

The application automatically generates

- Candidate Information
- Interview Transcript
- ATS Score
- Technical Score
- Communication Score
- Recommendation
- Excel Evaluation Report

---

# Environment Variables

```env
NODE_ENV=development

PORT=3000

OPENAI_API_KEY=

MODEL_NAME=gpt-4o-mini

CORS_ORIGINS=http://localhost:4200
```

---

# Future Improvements

- Multiple Resume Batch Processing
- Job Description Matching
- Resume Ranking
- Dashboard Analytics
- Recruiter Login
- Email Report Generation
- Candidate Database
- AI Voice Interview

---

# Screenshots

Add screenshots here.

Example:

```
screenshots/
    home.png
    upload.png
    report.png
```

---

# Author

**Chinmay Mathur**

B.Tech CSE (AI & ML)

Manipal University Jaipur

GitHub: https://github.com/chinmay270876

LinkedIn: https://linkedin.com/in/<your-profile>

---

# License

This project is licensed under the MIT License.
