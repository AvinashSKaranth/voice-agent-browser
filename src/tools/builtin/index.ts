import { tools } from '../registry';
import calculator from './calculator';
import datetime from './datetime';
import provider_switch from './provider_switch';
import describe_image from './describe_image';
import { read_document, search_documents } from './documents';
import clipboard from './clipboard';
import notes from './notes';
import open_url from './open_url';
import unit_convert from './unit_convert';
import run_js from './run_js';
import { remember, recall, forget } from './memory';
import { session_new, session_resume, transcript_export } from './session';
import { tts_set_voice, tts_set_rate } from './tts_settings';
import settings_set from './settings_set';
import http_request from './http_request';
import { skills_search, skills_install, use_skill } from './skills';
import alert from './alert';
import schedule_tool from './schedule_tool';
import { registerBridgeTools } from './bridge_tools';

const ALWAYS_ON = [
  calculator,
  datetime,
  provider_switch,
  describe_image,
  read_document,
  search_documents,
  clipboard,
  notes,
  open_url,
  unit_convert,
  run_js,
  remember,
  recall,
  forget,
  session_new,
  session_resume,
  transcript_export,
  tts_set_voice,
  tts_set_rate,
  settings_set,
  http_request,
  skills_search,
  skills_install,
  use_skill,
  alert,
  schedule_tool,
];

export function registerBuiltinTools(): void {
  for (const t of ALWAYS_ON) tools.register(t);
  registerBridgeTools();
}
