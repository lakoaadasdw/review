package demo;

import java.util.Map;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface JoinMapper {
    Map<String, Object> findForAdmin(String status, String platform, String country, int page, int size);
    long countForAdmin(String status, String platform, String country);
}
