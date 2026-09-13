import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import tdx_local


class TdxLocalStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_path = os.environ.get("QUANT_TDX_LOCAL_PATH")
        self.original_paths = os.environ.get("QUANT_TDX_LOCAL_PATHS")
        self.original_candidate_roots = tdx_local._candidate_tdx_roots
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        if self.original_path is None:
            os.environ.pop("QUANT_TDX_LOCAL_PATH", None)
        else:
            os.environ["QUANT_TDX_LOCAL_PATH"] = self.original_path
        if self.original_paths is None:
            os.environ.pop("QUANT_TDX_LOCAL_PATHS", None)
        else:
            os.environ["QUANT_TDX_LOCAL_PATHS"] = self.original_paths
        tdx_local._candidate_tdx_roots = self.original_candidate_roots
        self.tmp.cleanup()

    def test_reports_unavailable_when_configured_path_has_no_tdx_data(self) -> None:
        os.environ["QUANT_TDX_LOCAL_PATH"] = self.tmp.name
        os.environ.pop("QUANT_TDX_LOCAL_PATHS", None)
        tdx_local._candidate_tdx_roots = lambda: [Path(self.tmp.name)]

        status = tdx_local.get_tdx_local_status()

        self.assertFalse(status["available"])
        self.assertIsNone(status["selected_root"])
        self.assertEqual(status["configured_paths"], [self.tmp.name])

    def test_detects_vipdoc_and_block_files(self) -> None:
        root = Path(self.tmp.name)
        lday = root / "vipdoc" / "sh" / "lday"
        blocknew = root / "T0002" / "blocknew"
        lday.mkdir(parents=True)
        blocknew.mkdir(parents=True)
        (lday / "sh600519.day").write_bytes(b"0" * 32)
        (blocknew / "watch.blk").write_text("600519\n", encoding="utf-8")
        os.environ["QUANT_TDX_LOCAL_PATH"] = str(root)
        os.environ.pop("QUANT_TDX_LOCAL_PATHS", None)
        tdx_local._candidate_tdx_roots = lambda: [root]

        status = tdx_local.get_tdx_local_status()

        self.assertTrue(status["available"])
        self.assertEqual(status["selected_root"], str(root))
        self.assertEqual(status["selected"]["daily_files"]["sh"], 1)
        self.assertEqual(status["selected"]["block_files"], 1)
