"""Convert a Prisma PostgreSQL URL from stdin to a libpq URL without dropping TLS options."""
import sys
from urllib.parse import unquote, urlsplit, urlunsplit

PRISMA_PARAMETERS = {'schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size'}


def pg_dump_url(value):
    parts = urlsplit(value.strip())
    query = '&'.join(part for part in parts.query.split('&')
                     if unquote(part.partition('=')[0]) not in PRISMA_PARAMETERS)
    return urlunsplit(parts._replace(query=query))


if __name__ == '__main__':
    print(pg_dump_url(sys.stdin.read()))
