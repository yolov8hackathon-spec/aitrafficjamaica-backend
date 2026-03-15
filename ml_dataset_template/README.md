YOLO Dataset Template (Supabase + Modal)

This folder helps you prepare training files for the `ml-datasets` Supabase bucket.

Required dataset layout before zipping:

- images/train/*.jpg (or .png)
- images/val/*.jpg (or .png)
- labels/train/*.txt
- labels/val/*.txt

Each label file must match image filename and use YOLO format:

`class_id x_center y_center width height`

All values are normalized between 0 and 1.

Files you should upload to Supabase:

1. `data.yaml`
2. `whitelinez-yolo.zip` (contains images/ + labels/)

Recommended Supabase path:

- `ml-datasets/datasets/whitelinez/data.yaml`
- `ml-datasets/datasets/whitelinez/whitelinez-yolo.zip`

Then set Railway env var:

`TRAINER_DATASET_YAML_URL=https://<PROJECT_REF>.supabase.co/storage/v1/object/public/ml-datasets/datasets/whitelinez/data.yaml`

