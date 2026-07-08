import { C, stageBanner, writeToken } from './logger.js';

function inferStageName(msgs, opts) {
  const sysContent = msgs.filter(m => m.role === 'system').map(m => m.content || '').join(' ').toLowerCase();
  if (sysContent.includes('break down the problem') || sysContent.includes('analytical ai')) {
    return 'Analysis (depth stage 1)';
  }
  if (sysContent.includes('strategic ai') || sysContent.includes('formulate a comprehensive plan')) {
    return 'Planning (depth stage 2)';
  }
  if (sysContent.includes('evaluation ai') || sysContent.includes('sanity check')) {
    return 'Evaluation (depth stage 3)';
  }
  if (sysContent.includes('quality check') || sysContent.includes('adversarial audit') || sysContent.includes('numerical check')) {
    return 'Self-Check Pass';
  }
  if (sysContent.includes('hyperparameter tuner') || sysContent.includes('autochoose')) {
    return 'Auto Hyperparameter Selection';
  }
  if (sysContent.includes('compress these memory items')) {
    return 'Brain Memory Consolidation';
  }
  if (sysContent.includes('requirement engineering') || sysContent.includes('requirements engineering')) {
    return 'Requirement Expansion';
  }
  if (sysContent.includes('ux/design agent') || sysContent.includes('ux and design')) {
    return 'UX / Design Review';
  }
  if (sysContent.includes('security and performance auditor')) {
    return 'Security & Performance Review';
  }
  if (sysContent.includes('user simulation agent')) {
    return 'User Simulation';
  }
  const sp = (opts.systemPrompt || '').toLowerCase();
  if (sp.includes('elite frontend engineer')) return 'Final HTML Generation';
  if (sp.includes('expert frontend engineer')) return 'Patch Generation';
  return 'LLM Call';
}
export function patchDeepthinkInstance(dt, onChunk) {
  const originalCallChat = dt.callChat.bind(dt);
  dt.callChat = async function monkeyCallChat(msgs, stream = false, callerOnChunk = null, opts = {}) {
    const stageName = inferStageName(msgs, opts);
    let thinkingStarted = false;
    let thinkingBuffer = '';
    let contentBuffer = '';

    function dispatchChunk(token, meta) {
      const kind = meta?.kind || 'content';
      if (kind === 'thinking') {
        if (!thinkingStarted) {
          thinkingStarted = true;
          if (typeof onChunk === 'function') {
            onChunk({
              stage: stageName,
              kind: 'thinking_start',
              token: ''
            });
          }
        }
        thinkingBuffer += token;
        if (typeof onChunk === 'function') {
          onChunk({
            stage: stageName,
            kind: 'thinking',
            token
          });
        }
      } else {
        if (thinkingStarted && contentBuffer === '') {
          if (typeof onChunk === 'function') {
            onChunk({
              stage: stageName,
              kind: 'thinking_end',
              token: ''
            });
          }
        }
        contentBuffer += token;
        if (typeof onChunk === 'function') {
          onChunk({
            stage: stageName,
            kind: 'content',
            token
          });
        }
      }
      if (typeof callerOnChunk === 'function') {
        callerOnChunk(token, meta);
      }
    }
    if (typeof onChunk === 'function') {
      onChunk({
        stage: stageName,
        kind: 'stage_start',
        token: ''
      });
    }
    const result = await originalCallChat(msgs, true, dispatchChunk, opts);
    if (typeof onChunk === 'function') {
      onChunk({
        stage: stageName,
        kind: 'stage_end',
        token: '',
        thinking: thinkingBuffer,
        content: contentBuffer
      });
    }
    return result;
  };
}