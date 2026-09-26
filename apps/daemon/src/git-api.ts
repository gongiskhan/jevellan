import { GitCheckRequestSchema, GitSettings } from '@jevellan/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';

/** Called only after normal browser authentication and origin checks. */
export async function handleGitApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL) {
  const settings = new GitSettings(app.homes);
  const send = (value: unknown) => json(response, app.redactor.document(value));
  if (url.pathname === '/api/git/settings') {
    if (request.method === 'GET') { send(settings.get()); return true; }
    if (request.method === 'PUT') { send(settings.save(await requestBody(request))); return true; }
  }
  if (url.pathname === '/api/git/check' && request.method === 'POST') {
    const input = GitCheckRequestSchema.parse(await requestBody(request));
    const project = (await app.conversations.projects()).projects.find(row => row.project.id === input.projectId)?.project;
    if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 });
    send(await settings.check(project, app.device.deviceId, app.redactor)); return true;
  }
  return false;
}
