import math
import unittest

from worker import DECAY, HORIZON, ewma_volatility, full_windows, pinball, rule_forecasts


class ForecastRulesTest(unittest.TestCase):
    def test_rule_forecast_uses_only_matured_windows(self):
        prices = [math.log(100 + day + 2 * math.sin(day)) for day in range(180)]
        origin = 143
        future_changed = [*prices[:origin + 1], *([100.0] * (len(prices) - origin - 1))]
        expected = rule_forecasts(prices, ewma_volatility(prices), origin)
        self.assertEqual(expected, rule_forecasts(future_changed, ewma_volatility(future_changed), origin))
        self.assertTrue(all(start + HORIZON <= origin for start in full_windows(origin)))
        self.assertTrue(all(band == sorted(band) for band in expected.values()))
        self.assertEqual(expected["flat"][1], 0.0)
        self.assertEqual(expected["ewma"][1], 0.0)

    def test_decayed_variance_and_proper_quantile_loss(self):
        self.assertAlmostEqual(ewma_volatility([0.0, 0.10])[-1], math.sqrt(1 - DECAY) * 0.10)
        self.assertEqual(pinball([0.1, 0.1, 0.1], 0.1), 0.0)
        self.assertAlmostEqual(pinball([-0.1, 0.0, 0.1], 0.0), 0.02 / 3)


if __name__ == "__main__":
    unittest.main()
