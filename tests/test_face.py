import json
import tempfile
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from unittest.mock import patch

from PIL import Image

import face
from vision_api import ModelError


def prediction():
    return {
        "driver_present": True, "needs_review": False, "review_note": "",
        "group_evidence": {g["name"]: "Thấy đường viền." for g in face.GROUPS},
        "points": [{"id": i, "state": "Visible", "x": i + 2, "y": 6,
                    "evidence": "Thấy đường viền."} for i in range(50)],
    }


class FaceCoordinates(unittest.TestCase):
    def test_second_pass_limit_reuses_first_pass_in_this_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            Image.new("RGB", (64, 32)).save(folder / "frame-original", format="PNG")
            first = prediction()
            with patch.object(face, "infer", side_effect=[first, ModelError("RATE_LIMIT", "HTTP 429", 90)]):
                with self.assertRaisesRegex(ModelError, "Lượt 2") as caught:
                    face.process(folder)
            self.assertEqual(caught.exception.retry_after, 90)
            self.assertEqual(json.loads((folder / "first-pass.json").read_text(encoding="utf-8")), first)
            self.assertFalse((folder / "prediction.json").exists())
            with patch.object(face, "infer", return_value=prediction()) as infer:
                face.process(folder, resume_first=True)
                infer.assert_called_once()
                self.assertIn("Recheck ALL 50", infer.call_args.args[1])
            self.assertTrue((folder / "prediction.json").exists())

    def test_both_passes_normalize_omitted_outside_axes_in_saved_result(self):
        first, second = prediction(), prediction()
        for result in (first, second):
            p = result["points"][0]
            p["state"] = "Outside"
            del p["x"], p["y"]
        with tempfile.TemporaryDirectory() as tmp, patch.object(face, "infer", side_effect=[first, second]) as infer:
            folder = Path(tmp)
            Image.new("RGB", (64, 32)).save(folder / "frame-original", format="PNG")
            face.process(folder)
            self.assertEqual(infer.call_count, 2)
            for name in ("first-pass", "prediction"):
                points = json.loads((folder / (name + ".json")).read_text(encoding="utf-8"))["points"]
                self.assertEqual([p["id"] for p in points], list(range(50)))
                self.assertEqual((points[0]["state"], points[0]["x"], points[0]["y"]), ("Outside", None, None))

    def test_missing_visible_axis_can_be_corrected_on_same_pass(self):
        invalid, valid = prediction(), prediction()
        del invalid["points"][0]["x"]
        with patch.object(face, "infer", side_effect=[invalid, valid]) as infer:
            result = face.infer_pass([], "rules", (64, 32), "Lượt 1")
            self.assertEqual(result["points"][0]["x"], 2)
            self.assertIn("Điểm 0 (Visible) thiếu tọa độ x", infer.call_args.args[1])

    def test_repeated_missing_occluded_coordinate_reports_point_and_pass(self):
        invalid = prediction()
        invalid["points"][42].update(state="Occluded", y=None)
        with patch.object(face, "infer", return_value=invalid) as infer:
            with self.assertRaisesRegex(ValueError, r"Lượt 2: Điểm 42 \(Occluded\) thiếu tọa độ y"):
                face.infer_pass([], "rules", (64, 32), "Lượt 2")
            self.assertEqual(infer.call_count, 2)

    def test_outside_with_numeric_axis_is_still_invalid(self):
        invalid = prediction()
        invalid["points"][0].update(state="Outside", y=None)
        with self.assertRaisesRegex(ValueError, "Điểm 0"):
            face.ordered(invalid, (64, 32))
