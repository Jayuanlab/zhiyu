import unittest
from app.quality import dashboard_quality


class QualityTests(unittest.TestCase):
    def test_watchlist_does_not_become_full_market(self):
        result = dashboard_quality({"market": {"market_scope": "watchlist_fallback", "temperature": 100}, "generated_at": "2026-09-06T12:00:00+08:00"})
        self.assertEqual(result["scope"], "watchlist")
        self.assertIsNone(result["observedAt"])
        self.assertEqual(result["qualityStatus"], "degraded")

    def test_observation_is_not_replaced_with_generation_time(self):
        result = dashboard_quality({"market": {"market_scope": "full_market", "observed_at": "2026-09-04T15:00:00+08:00"}, "generated_at": "2026-09-06T12:00:00+08:00"})
        self.assertEqual(result["quoteSessionDate"], "2026-09-04")
        self.assertEqual(result["observedAt"], "2026-09-04T15:00:00+08:00")
        self.assertIsNone(result["calendarVersion"])

    def test_sample_is_never_full_market(self):
        self.assertEqual(dashboard_quality({"service_mode": "sample", "market": {"market_scope": "full_market"}})["scope"], "sample")

    def test_invalid_or_unzoned_observations_are_not_ready(self):
        for value in ["invalid", "2026-09-04T15:00:00"]:
            result = dashboard_quality({"market": {"market_scope": "full_market", "observed_at": value}})
            self.assertIsNone(result["observedAt"])
            self.assertEqual(result["qualityStatus"], "degraded")

    def test_expired_market_cache_is_stale(self):
        self.assertEqual(dashboard_quality({"market": {"cache": {"expires_at": "2000-01-01T00:00:00Z"}}})["qualityStatus"], "stale")
