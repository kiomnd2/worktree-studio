import net from 'node:net';

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL'));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen({ port, host, exclusive: true });
  });
}

/** IPv4와 IPv6 모두에서 비어 있는 포트를 start부터 찾는다. taken은 이미 배정한 포트. */
export async function findFreePort(start: number, taken: Set<number>): Promise<number> {
  for (let p = start; p < start + 500; p++) {
    if (taken.has(p)) continue;
    if ((await canListen(p, '127.0.0.1')) && (await canListen(p, '::1')) && (await canListen(p, '0.0.0.0'))) return p;
  }
  throw new Error(`${start}번부터 500개 안에서 빈 포트를 찾지 못했습니다.`);
}
