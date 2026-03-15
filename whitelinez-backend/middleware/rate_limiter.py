"""
rate_limiter.py — Per-IP and per-user sliding window rate limits using SlowAPI.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
