# StudyBuddy AI - Backend Server

This is the secure backend for StudyBuddy AI. It keeps your Gemini API key safe on the server instead of in the mobile app.

## Setup

1. Install dependencies:
   ```bash
   cd server
   npm install
   ```

2. Create a `.env` file:
   ```bash
   cp .env.example .env
   ```

3. Add your Gemini API key to `.env`:
   - Get a free API key at https://aistudio.google.com/apikey
   - Paste it in the `.env` file

4. Start the server:
   ```bash
   npm start
   ```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ask` | POST | Ask AI a question |
| `/api/flashcards` | POST | Generate flashcards |
| `/api/quiz` | POST | Generate a quiz |
| `/api/explain` | POST | Explain a topic |
| `/api/summarize` | POST | Summarize notes |

## Deployment (Free)

You can deploy this backend for free on:

- **Render** (render.com) - Free tier available
- **Railway** (railway.app) - Free tier available
- **Vercel** (vercel.com) - Convert to serverless functions

## Mobile App Configuration

Update the API URL in `src/services/ai.ts` to point to your deployed server:

```typescript
const API_URL = 'https://your-server.com';
```
