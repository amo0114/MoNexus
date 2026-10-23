import importlib.util
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlsplit

spec = importlib.util.spec_from_file_location('pg_dump_url', Path(__file__).with_name('pg-dump-url.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PgDumpUrlTest(unittest.TestCase):
    def test_preserves_tls_credentials_and_libpq_options(self):
        source = 'postgresql://user:p%40ss@host/db?schema=public&sslmode=verify-full&sslrootcert=%2Fcerts%2Froot.pem&connect_timeout=10&connection_limit=5'
        result = urlsplit(module.pg_dump_url(source))
        self.assertEqual(result.netloc, 'user:p%40ss@host')
        self.assertEqual(parse_qs(result.query), {'sslmode': ['verify-full'], 'sslrootcert': ['/certs/root.pem'], 'connect_timeout': ['10']})

    def test_preserves_query_encoding(self):
        query = 'options=-c%20statement_timeout%3D5000&application_name=backup+job'
        self.assertEqual(module.pg_dump_url('postgres://host/db?schema=public&' + query), 'postgres://host/db?' + query)

    def test_plain_and_schema_only_urls(self):
        self.assertEqual(module.pg_dump_url('postgres://user@host/db'), 'postgres://user@host/db')
        self.assertEqual(module.pg_dump_url('postgres://user@host/db?schema=public'), 'postgres://user@host/db')


if __name__ == '__main__':
    unittest.main()
