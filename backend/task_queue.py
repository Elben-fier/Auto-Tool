import time
import threading


class TaskQueue:
    """单线程串行任务队列，带速率限制（默认3条/秒）"""

    def __init__(self, rate_limit=3, max_pending=100):
        self._lock = threading.Lock()
        self._min_interval = 1.0 / rate_limit
        self._last_request_at = 0.0
        self._pending_count = 0
        self._max_pending = max_pending
        self._count_lock = threading.Lock()

    @property
    def is_full(self):
        with self._count_lock:
            return self._pending_count >= self._max_pending

    def acquire(self):
        """阻塞直到可以执行下一个任务，返回是否成功获取"""
        with self._count_lock:
            if self._pending_count >= self._max_pending:
                return False
            self._pending_count += 1

        with self._lock:
            now = time.time()
            wait = self._last_request_at + self._min_interval - now
            if wait > 0:
                time.sleep(wait)
            self._last_request_at = time.time()
            return True

    def release(self):
        with self._count_lock:
            self._pending_count = max(0, self._pending_count - 1)
