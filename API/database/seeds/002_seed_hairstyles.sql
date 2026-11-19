
INSERT INTO hairstyles (
    hairstyle_name,
    description,
    face_shape,
    hair_type,
    is_active
)
SELECT
    data.hairstyle_name,
    data.description,
    data.face_shape,
    data.hair_type,
    TRUE
FROM (
    VALUES
        ('Textured Crop', 'Potongan pendek dengan tekstur pada bagian atas.', 'oval', 'straight'),
        ('French Crop', 'Potongan pendek dengan poni ke depan.', 'round', 'straight'),
        ('Side Part', 'Model rambut belah samping yang rapi.', 'square', 'straight'),
        ('Quiff', 'Rambut bagian depan dibuat lebih bervolume.', 'oval', 'wavy'),
        ('Pompadour', 'Model rambut dengan volume tinggi di bagian depan.', 'square', 'straight'),
        ('Buzz Cut', 'Potongan rambut sangat pendek dan praktis.', 'diamond', 'all'),
        ('Crew Cut', 'Potongan pendek dengan bagian atas sedikit lebih panjang.', 'oblong', 'straight'),
        ('Curtain Hair', 'Model rambut belah tengah dengan poni menjuntai.', 'heart', 'wavy'),
        ('Comma Hair', 'Model poni melengkung menyerupai tanda koma.', 'oval', 'straight'),
        ('Wolf Cut', 'Potongan berlapis dengan tekstur dan volume.', 'heart', 'wavy'),
        ('Mullet', 'Model rambut dengan bagian belakang lebih panjang.', 'diamond', 'wavy'),
        ('Slick Back', 'Rambut disisir ke belakang agar terlihat rapi.', 'square', 'straight'),
        ('Curly Top', 'Potongan dengan mempertahankan tekstur ikal di bagian atas.', 'round', 'curly'),
        ('Undercut', 'Bagian samping dibuat pendek dengan bagian atas lebih panjang.', 'oval', 'all')
) AS data (
    hairstyle_name,
    description,
    face_shape,
    hair_type
)
WHERE NOT EXISTS (
    SELECT 1
    FROM hairstyles existing
    WHERE existing.hairstyle_name = data.hairstyle_name
);
