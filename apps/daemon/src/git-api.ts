import { GitCheckRequestSchema, GitSettings } from '@jevellan/core';
import {readGitEditor,checkGitProject,readGitTokenEditor} from './git-editor.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';

/** Called only after normal browser authentication and origin checks. */
export async function handleGitApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL) {
  const settings = new GitSettings(app.homes);
  const send = (value: unknown) => json(response, app.redactor.document(value));
  if(url.pathname==='/api/git/view'&&request.method==='GET'){send(await readGitEditor(app));return true;}
  if(url.pathname==='/api/git/token-view'&&request.method==='GET'){send(await readGitTokenEditor(app,{schema:'github-token-read-v1',...(url.searchParams.has('projectId')?{projectId:url.searchParams.get('projectId')}:{})}));return true;}
  if (url.pathname === '/api/git/settings') {
    if (request.method === 'GET') { send(settings.get()); return true; }
    if (request.method === 'PUT') { send(settings.save(await requestBody(request))); return true; }
  }
  if (url.pathname === '/api/git/check' && request.method === 'POST') {
    const input = GitCheckRequestSchema.parse(await requestBody(request));
    send(await checkGitProject(app,input)); return true;
  }
  return false;
}
