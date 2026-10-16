"""
The Python must still produce exactly the reference outputs in
tools/conformance/cases/*/expected.   Run:  python tests/test_conformance.py
If a change is intended, run  python tools/conformance/build.py  to update them.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "conformance"))
import build  # noqa: E402


class Conformance(unittest.TestCase):
    def test_every_case_matches_its_expected_output(self):
        self.assertEqual(build.main(["build.py", "--check"]), 0)


if __name__ == "__main__":
    unittest.main()
