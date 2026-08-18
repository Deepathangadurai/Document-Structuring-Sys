// src/App.tsx
import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/appshell'
import Dashboard from './components/Dashboard'
import ProjectsList from './components/Projectlist'
import Templates from './components/Templates'
import TemplatePending from './components/TemplatePending'
import TemplateReview from './components/TemplateReview'
import TemplatePageReview from './components/TemplatePageReview'

// 1. Fix CreateProject import to target Createproject.. directly in src/
import CreateProject from "./Createproject";
import ProjectDetail from './components/ProjectDetail'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<ProjectsList />} />
        <Route path="/projects/new" element={<CreateProject />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/templates/pending" element={<TemplatePending />} />
        <Route path="/templates/pending/:templateId/review" element={<TemplatePageReview />} />
        <Route path="/templates/pending/:id" element={<TemplateReview />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}