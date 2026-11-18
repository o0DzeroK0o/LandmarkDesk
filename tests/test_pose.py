import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from pose import EDGES, NAMES, final_points, label_map, reversed_pairs, validate


class PoseValidation(unittest.TestCase):
    def setUp(self):
        self.person = {"type":"skeleton","name":"person","sublabels":[
            {"id":1010+i,"name":str(i)+"_"+n,"type":"points"} for i,n in enumerate(NAMES,1)]}
        self.pose = {"driver_present":True,"points":[
            {"id":i,"state":"Visible","x":i*10,"y":i*7} for i in range(1,18)]}

    def test_backend_ids_not_array_position(self):
        self.person["sublabels"].reverse()
        self.assertEqual(label_map(self.person)[17],1027)

    def test_explicit_id_conflicting_with_name(self):
        self.person["sublabels"][1]["name"]="2-LeftEye"
        with self.assertRaises(ValueError):
            label_map(self.person)

    def test_live_job_schema_and_native_image_size(self):
        self.person["name"]="person_vf17"
        for i,item in enumerate(self.person["sublabels"],1):
            item["name"]=str(i)
        self.assertEqual(label_map(self.person)[1],1011)
        self.pose["points"][0].update(x=511,y=423)
        self.assertEqual(len(validate(self.pose,(512,424))),17)
        self.pose["points"][0]["y"]=424
        with self.assertRaises(ValueError):
            validate(self.pose,(512,424))

    def test_hidden_joint_and_rightmost_edge(self):
        self.pose["points"][0].update(state="Outside",x=None,y=None)
        self.pose["points"][1].update(state="Occluded",x=959,y=539)
        self.assertEqual(len(validate(self.pose,(960,540))),17)
        self.pose["points"][1]["x"]=960
        with self.assertRaises(ValueError):
            validate(self.pose,(960,540))

    def test_missing_driver_and_duplicate_ids(self):
        self.assertEqual(validate({"driver_present":False,"points":[]},(960,540)),[])
        self.pose["points"][-1]["id"]=16
        with self.assertRaises(ValueError):
            validate(self.pose,(960,540))

    def test_coincident_visible_points(self):
        self.pose["points"][1].update(x=10,y=7)
        with self.assertRaises(ValueError):
            validate(self.pose,(960,540))

    def test_outside_can_omit_coordinates(self):
        self.pose["points"][10]={"id":11,"state":"Outside"}
        p=validate(self.pose,(512,424))[10]
        self.assertEqual((p["x"],p["y"]), (None,None))
        p["x"]=25
        with self.assertRaises(ValueError):
            validate(self.pose,(512,424))

    def test_located_joints_require_both_coordinates(self):
        p=self.pose["points"][0]
        del p["y"]
        for state in ("Visible","Occluded"):
            with self.subTest(state=state), self.assertRaises(ValueError):
                p["state"]=state
                validate(self.pose,(512,424))

    def test_final_review_requires_evidence_for_every_joint(self):
        self.pose.update(needs_review=False, review_note="Một khớp bị che.")
        for p in self.pose["points"]:
            p["evidence"]="Thấy khớp trong ảnh."
        self.assertEqual(len(final_points(self.pose,(512,424))),17)
        del self.pose["points"][16]["evidence"]
        with self.assertRaises(ValueError):
            final_points(self.pose,(512,424))

    def test_guideline_overlay_topology(self):
        self.assertEqual(len(set(EDGES)),18)
        self.assertIn((4,6),EDGES)
        self.assertIn((5,7),EDGES)

    def test_flag_image_side_order_without_swapping_limbs(self):
        points=[{"id":14,"x":600,"state":"Visible"},{"id":15,"x":695,"state":"Occluded"},
                {"id":16,"x":None,"state":"Outside"},{"id":17,"x":900,"state":"Visible"}]
        self.assertEqual(reversed_pairs(points),[(14,15)])
