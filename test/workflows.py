"""Integration checks against a local protocol fixture, never a paid API."""
import json
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parents[1]
calls = []

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        calls.append(self.path)
        if self.path.endswith('/embeddings'):
            output = {'object': 'list', 'model': 'fixture-embedding', 'data': [{'object': 'embedding', 'index': i, 'embedding': [1.0, 0.2, 0.3, 0.4]} for i, _ in enumerate(request['input'])], 'usage': {'prompt_tokens': 1, 'total_tokens': 1}}
        else:
            messages = request['messages']
            schema = request.get('response_format', {}).get('json_schema', {}).get('name')
            if schema == 'SkillProfile':
                field = {'text': 'Process fixture data', 'evidence': [{'line': 6}]}
                content = {'capability': field, 'when_to_use': [field], 'inputs': [field], 'outputs': [field], 'constraints': [], 'tools': [], 'scenarios': [{'name': 'Data processing', 'before': [field], 'after': [field]}]}
            elif schema == 'RelationJudgment':
                pair = json.loads(messages[-1]['content'])['skills']
                content = {'decision': {'outcome': 'related', 'relations': [{'source': pair[0]['skill_id'], 'target': pair[1]['skill_id'], 'type': 'compose_with', 'contexts': [{'scenario': 'Data processing', 'explanation': 'Pass output to the next skill.', 'conditions': [], 'source_evidence': [{'line': 6}], 'target_evidence': [{'line': 6}]}]}]}}
            elif 'expert evaluator' in str(messages[0].get('content', '')):
                content = {name: {'level': 'Good', 'reason': 'Local fixture evidence.'} for name in ('safety', 'completeness', 'executability', 'cost_awareness', 'maintainability')}
            elif 'expert Technical Writer' in str(messages[0].get('content', '')):
                content = '## FILE: generated-fixture/SKILL.md\n```markdown\n---\nname: generated-fixture\ndescription: Reuse fixture data processing\n---\n# Fixture\nProcess data carefully.\n```\n'
            else:
                content = {'skills': [{'skill_id': 'fixture-one', 'reason': 'This fixture handles the requested data.'}]}
            encoded = content if isinstance(content, str) else json.dumps(content)
            if self.path.endswith('/messages'):
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                for value in [
                    {'type': 'message_start', 'message': {'id': 'fixture', 'type': 'message', 'role': 'assistant', 'model': 'fixture-chat', 'content': [], 'usage': {'input_tokens': 1, 'output_tokens': 0}}},
                    {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                    {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': encoded}},
                    {'type': 'content_block_stop', 'index': 0},
                    {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 1}},
                    {'type': 'message_stop'},
                ]:
                    self.wfile.write(('event: ' + value['type'] + '\ndata: ' + json.dumps(value) + '\n\n').encode())
                self.wfile.flush(); return
            if request.get('stream'):
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                for value in [
                    {'id': 'fixture', 'object': 'chat.completion.chunk', 'model': 'fixture-chat', 'created': 1, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': encoded}, 'finish_reason': None}]},
                    {'id': 'fixture', 'object': 'chat.completion.chunk', 'model': 'fixture-chat', 'created': 1, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}},
                ]:
                    self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush(); return
            output = {'id': 'fixture', 'object': 'chat.completion', 'model': 'fixture-chat', 'created': 1, 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': encoded}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(output).encode())

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/v1'
settings = {'api_key': 'local-fixture', 'base_url': base, 'model': 'fixture-chat', 'embedding_api_key': 'local-fixture', 'embedding_base_url': base, 'embedding_model': 'fixture-embedding', 'explorer_api_key': 'local-fixture', 'explorer_base_url': base, 'explorer_model': 'fixture-chat', 'explorer_backend': 'dsh'}

def worker(action, **kwargs):
    process = subprocess.run([sys.executable, str(root / 'python/worker.py')], input=json.dumps({'action': action, 'retrievalMode': 'vector', '_settings': settings, **kwargs}), text=True, encoding='utf-8', capture_output=True, timeout=100)
    value = json.loads(process.stdout)
    if not value['ok']:
        raise AssertionError(f'{action}: {value["error"]}')
    return value['data']

try:
    with tempfile.TemporaryDirectory(prefix='skillnet-workflow-') as temporary:
        library = Path(temporary) / 'skills'
        for name in ('fixture-one', 'fixture-two'):
            path = library / name
            path.mkdir(parents=True)
            (path / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: Data processing fixture\n---\n# Fixture\nProcess fixture data.\n', encoding='utf-8')
        index = library / '.skillnet'
        before = worker('local-library', sourcePath=str(library))
        assert before['analysisStatus'] == 'missing'
        first = worker('analyze', sourcePath=str(library), indexPath=str(index))
        assert first['skill_count'] == 2 and first['relation_counts']['compose_with'] == 1
        current = worker('local-library', sourcePath=str(library), indexPath=str(index))
        assert current['analysisStatus'] == 'ready' and len(current['graph']['relations']) == 1
        count = len(calls)
        second = worker('analyze', sourcePath=str(library), indexPath=str(index))
        assert second['cache_hits']['profiles'] == 2 and second['cache_hits']['relations'] == 1
        assert len(calls) == count, 'A repeated successful analysis should reuse its model cache.'
        routed = worker('route', query='Process fixture data', indexPath=str(index), backend='dsh')
        assert routed['skills'][0]['skill_id'] == 'fixture-one'
        created = worker('create', input_type='prompt', prompt='Build a reusable fixture skill', output_dir=str(Path(temporary) / 'drafts'))
        assert created['drafts'][0]['validation']['valid']
        evaluated = worker('evaluate', path=str(library / 'fixture-one'), cache_dir=str(Path(temporary) / 'evaluation'))
        assert evaluated['safety']['level'] == 'Good'
        # The existing advanced API option remains independent of retrieval
        # mode: the embedding-free workflow must not resolve/use embeddings.
        independent = {key: value for key, value in settings.items() if not key.startswith('embedding_')}
        model_index = Path(temporary) / 'model-index'
        vector_calls = calls.count('/v1/embeddings')
        model_graph = worker('analyze', sourcePath=str(library), indexPath=str(model_index), retrievalMode='model', _settings=independent)
        assert model_graph['skill_count'] == 2
        model_route = worker('route', sourcePath=str(library), indexPath=str(model_index), query='Process fixture data', backend='dsh', retrievalMode='model', _settings=independent)
        assert model_route['skills'][0]['skill_id'] == 'fixture-one'
        assert calls.count('/v1/embeddings') == vector_calls
        assert len(model_route['source_versions']) == 2
        print(json.dumps({'analyze': first, 'cache': second['cache_hits'], 'route': routed, 'create': [draft['name'] for draft in created['drafts']], 'evaluate': evaluated, 'requests': len(calls), 'provider': 'localhost protocol fixture, no real inference'}, ensure_ascii=False))
finally:
    server.shutdown(); server.server_close()
