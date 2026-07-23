# AI-Powered CRM & Booking Agent

A premium, modern client relationship management (CRM) platform and automated booking agent designed for high-intent lead generation, tracking, and messaging workflows.

## Architecture Overview

This project implements a **Hub-and-Spoke** data pipeline:
*   **The Hub (Firestore Database)**: Centralizes all lead details, conversation histories across multiple channels (Email/WhatsApp), and system configurations.
*   **The Spoke Client (Next.js Dashboard)**: A responsive, beautifully styled Next.js interface with real-time state tracking, Kanban pipelines, and interactive messaging hubs.
*   **The Spoke Worker (Firebase Cloud Functions)**: An automated Node.js backend executing background business logic, triggered by Gmail push notifications.

---

## Features

### 1. Smart Next.js Lead Management Portal
*   **Authentication Guard**: Secure login portal using Firebase Auth supporting email/password and Google Single Sign-On (SSO).
*   **Kanban Board Pipeline**: Drag-and-drop board to manage leads through stages (`New`, `Contacted`, `Interested`, `Qualified`, `Closed`).
*   **Split-Pane Inbox**: Centralized messaging panel that renders chat bubbles dynamically formatted for the communication channel (green WhatsApp bubbles vs. enterprise email panels).
*   **AI Command Center**: Allows administrators to configure and update the system's global AI persona dynamically.
*   **Interactive Metrics**: Real-time KPI counters (e.g., Conversion Rates, High-Intent Counts, Processed Messages) with adjustable time-period filters.
*   **CSV Exporter**: Single-click exporting of qualified leads for external analytics.

### 2. Automated Gmail Ingestion & Response Pipeline
*   **Pub/Sub Ingestion**: Real-time trigger triggered by Gmail push notifications via Google Cloud Pub/Sub.
*   **Subject-Line Gatekeeper**: Filters out cold inquiries by verifying if they have a Google Click ID (`gcid`) in the subject line, processing only qualified new traffic or returning clients.
*   **Human Takeover Killswitch**: If an administrator sets `bot_active: false` inside a lead's profile, the automated agent stops responding to allow manual follow-ups, while still logging the incoming emails.
*   **Gemini AI Response & Scoring**: Uses the `gemini-2.5-flash` model to analyze incoming text, dynamically load the admin-defined AI persona, query the lead's historical conversation thread, score the lead's intent (1-10), and draft a human-like reply.
*   **Email Threading**: Appends appropriate SMTP headers (`In-Reply-To`, `References`) and passes the original `threadId` so replies group perfectly in the client's inbox.
*   **Google Sheets Sync**: Appends newly captured leads automatically to a target Google Sheet for sheet-based workflows.

---

## Setup & Installation

### Prerequisites
*   Node.js 18+
*   Firebase CLI (configured for Firestore and Cloud Functions)
*   Google Cloud Platform project with Gmail API and Google Sheets API enabled
*   OAuth2 Client credentials for Gmail access

### 1. Dashboard Setup
1. Navigate to the `dashboard` directory:
    ```bash
    cd dashboard
    ```
2. Install dependencies:
    ```bash
    npm install
    ```
3. Create a `.env.local` file with your Firebase configuration parameters:
    ```env
    NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_auth_domain
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_storage_bucket
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_messaging_id
    NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
    ```
4. Start the local development server:
    ```bash
    npm run dev
    ```

### 2. Firebase Functions Backend Setup
1. Navigate to the `functions` directory:
    ```bash
    cd functions
    ```
2. Install dependencies:
    ```bash
    npm install
    ```
3. Create a `.env` file with backend environment parameters:
    ```env
    GEMINI_API_KEY=your_gemini_api_key
    GMAIL_USER=your_gmail_address
    GMAIL_CLIENT_ID=your_gmail_client_id
    GMAIL_CLIENT_SECRET=your_gmail_client_secret
    GMAIL_REFRESH_TOKEN=your_gmail_refresh_token
    GOOGLE_SHEET_ID=your_google_sheet_id
    ```
4. Build the TypeScript functions:
    ```bash
    npm run build
    ```
5. Deploy the backend:
    ```bash
    firebase deploy --only functions
    ```